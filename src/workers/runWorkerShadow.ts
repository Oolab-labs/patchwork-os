import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchworkHome } from "../patchworkHome.js";
import { MAX_PERSIST_LINES, RecipeRunLog } from "../runLog.js";
import { classifyActionClass } from "./actionClass.js";
import { deriveActionKey } from "./actionRef.js";
import { backtestWorker, formatBacktestReport } from "./backtest.js";
import { evidenceRetention } from "./evidenceRetention.js";
import { OutcomeStore, resolveOutcomeLogDir } from "./outcomeStore.js";
import {
  DEFAULT_DURABILITY_WINDOW_MS,
  type DecisionRecord,
  type RunRecord,
  WorkerShadowObserver,
  type WorkerShadowReport,
} from "./shadowObserver.js";
import { buildShadowReport, formatShadowReport } from "./shadowReport.js";
import {
  advanceWatermark,
  loadTrustCheckpoint,
  saveTrustCheckpoint,
  shouldIngestRun,
  type TrustWatermark,
  trustCheckpointPathFor,
} from "./trustCheckpoint.js";
import type { WorkerManifest } from "./worker.js";
import type { WorkerLevelStore } from "./workerLevelStore.js";
import { loadWorkersFromDir } from "./workerLoader.js";

/**
 * I/O entry for the shadow logger: read the REAL logs the bridge already
 * writes — `~/.patchwork/runs.jsonl` (RecipeRunLog → the dial's evidence) and
 * `~/.claude/ide/activity-*.jsonl` (the live gate's approval decisions) — and
 * produce the trust-dial + ramp-vs-gate report. Empty logs are honest, not an
 * error (new workers have no activity).
 *
 * The reporting paths (`getWorkerShadowData`, `runWorkerShadowReport`,
 * `runWorkerBacktest`) are read-only and touch nothing.
 *
 * `loadWorkerTrustForRecipe` is NOT: since backlog #10 it also WRITES a
 * per-recipe trust checkpoint under `<patchworkDir>/worker_trust/`. That is
 * deliberate — the dial's evidence used to live only inside a run log that
 * rotates, so a worker was silently un-earned whenever its runs aged out. The
 * write is best-effort and never fails a gate decision; see
 * [trustCheckpoint.ts](./trustCheckpoint.ts).
 */

export interface RunWorkerShadowOpts {
  /** Where worker manifests live (default ~/.patchwork/workers). */
  workersDir?: string;
  /** ~/.patchwork (runs.jsonl) override (tests). */
  patchworkDir?: string;
  /** ~/.claude/ide (activity-*.jsonl) override (tests). */
  ideDir?: string;
  /** Wall-clock override (tests) for durable-outcome labelling. Defaults to
   *  Date.now() — supplied here (the I/O entry) so the observer stays pure. */
  now?: number;
}

function readRuns(patchworkDir: string, recipeNames?: string[]): RunRecord[] {
  try {
    // Size the in-memory ring to the FULL disk retention (MAX_PERSIST_LINES), not
    // the default 500. `query()` only ever scans the ring, so with the default
    // cap a low-frequency worker's run is evicted once >500 unrelated runs land
    // after it — even with a per-recipe filter (the filter is applied AFTER ring
    // eviction). Matching the ring to the disk cap means worker evidence is
    // bounded only by what the log actually retains, not by global run volume.
    const log = new RecipeRunLog({
      dir: patchworkDir,
      memoryCap: MAX_PERSIST_LINES,
    });
    // Query FILTERED BY the worker recipes — NOT the global last-N window.
    // `query({})` defaults to the 100 most-recent runs, so a low-frequency
    // worker's evidence ages out behind unrelated high-frequency recipe traffic
    // (this is exactly why the test-guardian dial read empty despite a real,
    // correctly-executed run). Filtering means only same-recipe runs compete for
    // the window. DEDUP the names first: two manifests can declare the same
    // recipe, and an un-deduped flatMap would query it twice → ingest every run
    // twice → double-count the dial's evidence (a dial-vs-gate divergence, since
    // the live gate passes a single recipe name).
    const names = recipeNames?.length
      ? Array.from(new Set(recipeNames))
      : undefined;
    // `query` clamps limit to 500, but it now scans the full-history ring, so
    // this is the 500 most-recent runs OF THIS RECIPE — ample per-worker, and no
    // longer evictable by unrelated traffic.
    const live = names
      ? names.flatMap((recipe) => log.query({ recipe, limit: 500 }))
      : log.query({ limit: 500 });
    // Include runs rotation moved to `runs.jsonl.1`. The live file is capped by
    // BYTES while the durability window is defined in TIME, so a busy log
    // rotates a worker's filing away before it can settle — 18.2h of retention
    // against a 24h window, on the machine where this was found, which made
    // compensable and irreversible trust unearnable in principle rather than
    // merely slow. #1334 stopped rotation from deleting those rows; without
    // this read they were preserved somewhere nothing looked.
    //
    // Dedup by taskId across both files: a crash between rotation's archive
    // write and its trim can legitimately leave the same run in each, and
    // counting it twice would inflate the dial with evidence that happened once.
    const archived = names
      ? log.readArchive().filter((r) => names.includes(r.recipeName))
      : log.readArchive();
    const merged = new Map<string, (typeof live)[number]>();
    for (const r of [...archived, ...live]) {
      merged.set(r.taskId ? `task:${r.taskId}` : `seq:${r.seq}`, r);
    }
    const rows = Array.from(merged.values());
    return rows.map((r) => ({
      recipeName: r.recipeName,
      at: r.doneAt ?? r.startedAt ?? r.createdAt,
      steps: (r.stepResults ?? []).map((s) => ({
        tool: s.tool,
        status: s.status,
        haltReason: s.haltReason,
        // Carry the step inputs: the action-class key bands value-bearing
        // actions by magnitude, so dropping these files every outcome under
        // the widest band and inverts the protection (#1267 read-side only).
        ...(s.resolvedParams !== null &&
        typeof s.resolvedParams === "object" &&
        !Array.isArray(s.resolvedParams)
          ? { resolvedParams: s.resolvedParams as Record<string, unknown> }
          : {}),
        // Outcome attribution: carry the captured issue URL so ingestRun can
        // look up the issue's disposition in the outcome store. Only present on
        // github.create_issue steps (see yamlRunner.ts step output capture).
        ...(s.output !== undefined && typeof s.output === "object"
          ? { output: s.output as Record<string, unknown> }
          : {}),
      })),
    }));
  } catch {
    return [];
  }
}

function readDecisions(ideDir: string): DecisionRecord[] {
  let files: string[];
  try {
    files = readdirSync(ideDir).filter((f) => /^activity-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(path.join(ideDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      // cheap pre-filter before the JSON.parse; an empty line never matches
      if (!t.includes("approval_decision")) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (obj.event !== "approval_decision") continue;
      const md = (obj.metadata ?? {}) as Record<string, unknown>;
      const decision =
        md.decision === "allow"
          ? "allow"
          : md.decision === "deny"
            ? "deny"
            : null;
      if (typeof md.toolName !== "string" || !decision) continue;
      out.push({
        toolName: md.toolName,
        decision,
        at:
          typeof obj.timestamp === "string"
            ? Date.parse(obj.timestamp) || 0
            : 0,
        // Only present on worker-gate decisions (recipe runner path). Plain
        // Claude-session MCP approvals have no recipeName; ingestDecision
        // skips them so they don't inflate the ramp-vs-gate divergence count.
        ...(typeof md.recipeName === "string" && {
          recipeName: md.recipeName,
        }),
      });
    }
  }
  return out;
}

export interface WorkerShadowData {
  workers: WorkerShadowReport[];
  runsScanned: number;
  decisionsScanned: number;
  /** The directory worker manifests were loaded from (for empty-state copy). */
  workersDir: string;
}

/**
 * Structured shadow report — a read-only replay of the run + decision logs
 * through the (worker × action-class) ramp. Backs both the CLI and the bridge
 * `GET /workers/shadow` JSON endpoint. Pure aside from the log reads.
 */
export function getWorkerShadowData(
  opts: RunWorkerShadowOpts = {},
): WorkerShadowData {
  const home = os.homedir();
  const patchworkDir = opts.patchworkDir ?? path.join(home, ".patchwork");
  const ideDir = opts.ideDir ?? path.join(home, ".claude", "ide");
  const workersDir = opts.workersDir ?? path.join(patchworkDir, "workers");

  const workers = loadWorkersFromDir(workersDir);
  const runs = workers.length
    ? readRuns(
        patchworkDir,
        workers.map((w) => w.recipe).filter((r): r is string => !!r),
      )
    : [];
  const decisions = workers.length ? readDecisions(ideDir) : [];
  return {
    // `now` drives durable-outcome labelling (recent non-reversible successes
    // are withheld until they survive the durability window). Real Date.now() in
    // production; tests inject opts.now.
    workers: buildShadowReport(workers, runs, decisions, undefined, {
      now: opts.now ?? Date.now(),
      // The outcome log honors PATCHWORK_HOME (matching every write path) even
      // though runs.jsonl above is read from `patchworkDir` — the two files can
      // live in different roots. Resolving them the same way here would break
      // the confirm loop on a PATCHWORK_HOME box (write one file, read another).
      outcomeStore: new OutcomeStore(resolveOutcomeLogDir(opts.patchworkDir)),
    }),
    runsScanned: runs.length,
    decisionsScanned: decisions.length,
    workersDir,
  };
}

export interface RecipeWorkerTrust {
  worker: WorkerManifest;
  /** Earned-level store, replayed from the run log — same source as the dial. */
  store: WorkerLevelStore;
}

// loadWorkerTrustForRecipe is called TWICE per recipe run — once to build the
// per-step approval gate, once to compute the agent-step disallowed-tools list
// (recipeOrchestration.ts) — both before the run has produced any new log
// activity. Cache the result per (recipeName, patchworkDir, workersDir) keyed
// on runs.jsonl's mtime: unchanged mtime → the exact same replay would happen
// again, so reuse it; a changed mtime (a run completed, appending new rows)
// invalidates the entry.
//
// `now` drives durable-outcome labelling (a recent non-reversible success is
// WITHHELD until it survives a ~24h durability window — see shadowObserver),
// so it must be part of the cache key: two calls with a genuinely different
// `now` (e.g. a caller simulating the window elapsing) must NOT reuse each
// other's replay. Bucketing to the minute — rather than keying on the exact
// value — still lets the two real per-run calls (milliseconds apart,
// default `now: Date.now()`) share a cache hit, while anything that crosses
// a minute boundary (every test that injects a materially different `now`,
// and any real gap that could matter) gets a fresh replay.
const NOW_BUCKET_MS = 60_000;
interface TrustCacheEntry {
  runsLogMtimeMs: number;
  nowBucket: number;
  trust: RecipeWorkerTrust | null;
}
const trustCache = new Map<string, TrustCacheEntry>();

function statMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return -1; // file absent — distinct from any real mtime, still cacheable
  }
}

/**
 * Load the worker that owns `recipeName` (recipe === body) plus its earned-level
 * store, replayed from the same run log the dial uses. Returns null when no
 * worker owns the recipe (the common case — non-worker recipes are unaffected).
 *
 * This is the LIVE-gate entry: `workerGate.decideWorkerAction(worker, tool,
 * params, store)` reads the returned store. Memoized per (recipe, runs.jsonl
 * mtime) — see `trustCache` above — since both `buildWorkerAutonomyGate` and
 * `buildWorkerAgentDisallowedTools` call this for the same recipe run.
 */
export function loadWorkerTrustForRecipe(
  recipeName: string,
  opts: RunWorkerShadowOpts = {},
): RecipeWorkerTrust | null {
  const home = os.homedir();
  const patchworkDir = opts.patchworkDir ?? path.join(home, ".patchwork");
  const workersDir = opts.workersDir ?? path.join(patchworkDir, "workers");

  const cacheKey = `${patchworkDir}|${workersDir}|${recipeName}`;
  const runsLogMtimeMs = statMtimeMs(path.join(patchworkDir, "runs.jsonl"));
  const nowBucket = Math.floor((opts.now ?? Date.now()) / NOW_BUCKET_MS);
  const cached = trustCache.get(cacheKey);
  if (
    cached &&
    cached.runsLogMtimeMs === runsLogMtimeMs &&
    cached.nowBucket === nowBucket
  ) {
    return cached.trust;
  }

  const workers = loadWorkersFromDir(workersDir);
  const trust = ((): RecipeWorkerTrust | null => {
    if (!workers.length) return null;
    // Same durable-outcome labelling as the dial (one source of truth): the live
    // gate must not count a recent non-reversible success that could still be
    // reverted. Real Date.now() in production; tests inject opts.now.
    // Durable trust (backlog #10). Seed the dial from the checkpoint BEFORE
    // replaying, so evidence whose runs have rotated out of runs.jsonl is not
    // silently un-earned. Missing/corrupt checkpoint ⇒ empty store, i.e. exactly
    // the previous replay-only behaviour.
    const checkpointPath = trustCheckpointPathFor(patchworkDir, recipeName);
    const checkpoint = loadTrustCheckpoint(checkpointPath);
    const observer = new WorkerShadowObserver(workers, {
      now: opts.now ?? Date.now(),
      outcomeStore: new OutcomeStore(resolveOutcomeLogDir(opts.patchworkDir)),
      store: checkpoint.store,
    });
    const worker = observer.workerForRecipe(recipeName);
    if (!worker) return null;
    // Replay in ASCENDING timestamp order (review #1027 M2). The graduation
    // dwell/hysteresis logic is order-sensitive: ingesting newest-first leaves
    // `lastChangeAt` pinned to the most recent run so `dwellOk` never holds and
    // risky classes never promote — the earned-L4 path would be unreachable and
    // the gate would floor every compensable/irreversible class to L0 forever.
    // This mirrors buildShadowReport (the dial), so the gate and dial agree.
    // `recipeName` === the owning worker's recipe (workerForRecipe matched on it),
    // so filter the replay to just this recipe's runs.
    const runs = readRuns(patchworkDir, [recipeName]).sort(
      (a, b) => a.at - b.at,
    );
    // Fold only runs the checkpoint has not already absorbed. Without this the
    // replay would re-count every checkpointed run on each invocation and
    // inflate the dial toward autonomy on no new evidence — a fail-OPEN bug,
    // strictly worse than the fail-CLOSED loss this checkpoint exists to fix.
    let watermark: TrustWatermark = {
      watermarkAt: checkpoint.watermarkAt,
      idsAtWatermark: checkpoint.idsAtWatermark,
    };

    // Only SETTLED runs may be checkpointed. The durable-outcome fold is
    // time-dependent: a recent non-reversible success is WITHHELD, and the very
    // same run must count as evidence later, once it is past the durability
    // window. Checkpointing it on first sight would advance the watermark past
    // it forever, so it could never be re-evaluated and that evidence could
    // never accrue — the dial would silently cap itself. Two existing tests
    // caught exactly this.
    //
    // So: settled runs fold into the saved checkpoint; the recent tail is
    // replayed live on every evaluation and deliberately NOT saved. The tail is
    // bounded by the durability window, and those runs are still in the run log
    // by definition, so replaying them is both cheap and safe.
    const settledCutoff =
      (opts.now ?? Date.now()) - DEFAULT_DURABILITY_WINDOW_MS;
    let folded = 0;
    const tail: RunRecord[] = [];
    for (const run of runs) {
      if (!shouldIngestRun(run, watermark)) continue;
      if (run.at > settledCutoff) {
        tail.push(run); // provisional — replay, never checkpoint
        continue;
      }
      observer.ingestRun(run);
      watermark = advanceWatermark(watermark, run);
      folded++;
    }
    if (folded > 0) {
      try {
        // Saved BEFORE the tail is folded in, so the checkpoint holds only
        // settled evidence and the tail cannot be double-counted next time.
        saveTrustCheckpoint(checkpointPath, observer.levelStore, watermark);
      } catch {
        // Never let a checkpoint write failure break a live gate decision. The
        // worst case is the previous behaviour: replay from the run log.
      }
    }
    for (const run of tail) observer.ingestRun(run);
    return { worker, store: observer.levelStore };
  })();

  trustCache.set(cacheKey, { runsLogMtimeMs, nowBucket, trust });
  return trust;
}

export function runWorkerShadowReport(opts: RunWorkerShadowOpts = {}): string {
  const data = getWorkerShadowData(opts);
  if (data.workers.length === 0) {
    return `No worker manifests found in ${data.workersDir}.\nAdd *.worker.yaml there (e.g. copy templates/workers/) and re-run.\n`;
  }
  // Surface the retention cliff here rather than only in a log nobody reads.
  // A starved ledger does not look like a problem on this report — every dial
  // simply reads low, which is indistinguishable from a worker that has not
  // done much yet. Saying it out loud is the whole point: the read-side version
  // of this bug was fixed once and survived a layer down precisely because
  // nothing measured whether the invariant still held.
  const retention = evidenceRetention(
    opts.patchworkDir ?? patchworkHome(),
    opts.now !== undefined ? { now: opts.now } : {},
  );
  const warning = retention.sufficient ? "" : `\n⚠ ${retention.summary}\n`;
  return `${formatShadowReport(data.workers)}${warning}\n(scanned ${data.runsScanned} recipe runs, ${data.decisionsScanned} gate decisions · read-only)\n`;
}

/**
 * Backtest each installed worker over its historical run log and print the
 * divergence-calibration report (false-allow / false-gate). Read-only — the
 * cold-start "what would this worker have done across N real actions, and where
 * would it have diverged" artifact. See backtest.ts.
 */
export function runWorkerBacktest(opts: RunWorkerShadowOpts = {}): string {
  const home = os.homedir();
  const patchworkDir = opts.patchworkDir ?? path.join(home, ".patchwork");
  const workersDir = opts.workersDir ?? path.join(patchworkDir, "workers");
  const workers = loadWorkersFromDir(workersDir);
  if (!workers.length) {
    return `No worker manifests found in ${workersDir}.\nAdd *.worker.yaml there (e.g. copy templates/workers/) and re-run.\n`;
  }
  const lines: string[] = [
    "Worker trust BACKTEST — divergence calibration (read-only)",
    "  false-allow = ramp would auto-run a BAD action (over-trust, the risk)",
    "  false-gate  = ramp would gate a GOOD action (over-caution, the cost)",
    "",
  ];
  const outcomeStore = new OutcomeStore(
    resolveOutcomeLogDir(opts.patchworkDir),
  );
  for (const w of workers) {
    if (!w.recipe) continue;
    const runs = readRuns(patchworkDir, [w.recipe]);
    lines.push(formatBacktestReport(backtestWorker(w, runs, { outcomeStore })));
  }
  return lines.join("\n");
}

/** One filing awaiting an operator disposition — the confirm queue's unit. */
export interface PendingConfirmation {
  /**
   * The captured filing URL, when the tool returned one. Present for
   * `github.create_issue`-shaped filings; ABSENT for an action whose tool
   * exposes no permalink (`todoist.create_task` and most write tools).
   *
   * Consumers must key off `actionKey`, not this — see the note there. It is
   * retained because the dashboard renders it as a clickable link when it
   * exists, and "no link to show" is different from "no action to confirm".
   */
  issueUrl?: string;
  /**
   * The canonical join key for this filing — a URL, or `"<tool>:<id>"`.
   *
   * This is the field the confirm queue is keyed and deduped by. Before
   * #1319 the queue was URL-only, which meant a withheld non-URL action was
   * never OFFERED for confirmation: the trust fold withheld it and the UI had
   * no way to resolve it, so it could never earn trust through any path. A
   * gate that can withhold an action it cannot let you approve is worse than
   * no gate — it is an invisible permanent denial.
   */
  actionKey: string;
  /**
   * Structured reference for a non-URL filing, ready to POST to `/outcomes`.
   * Absent when `issueUrl` is the key.
   */
  ref?: { tool: string; id: string };
  recipeName: string;
  workerId: string;
  workerName: string;
  /** Epoch ms the filing ran. */
  filedAt: number;
  /** `domain:reversibility:blastTier` — the action class it counts toward. */
  classKey: string;
  /** The filing's human title, captured at filing time (the write tool echoes
   *  it back in the step output — e.g. `github.create_issue` returns `title`).
   *  Lets the dashboard review queue show "Login test failing on main" instead
   *  of a bare URL. Absent for older run-log rows written before capture. */
  title?: string;
}

/**
 * The CONFIRM QUEUE — every non-reversible filing (a URL a worker captured) that
 * has NO operator disposition yet (`unknown` / no record). These are exactly the
 * filings whose trust is WITHHELD until a human confirms or rejects them — the
 * queue `patchwork outcomes confirm|reject` exists to drain, and the moat KPI
 * (evidence latency) is the age of this queue. Read-only. Deduped by URL
 * (most-recent filing wins), newest first. Confirmed/junk filings are excluded
 * (already actioned); reversible actions are excluded (they never need
 * confirmation — they earn trust on their own). In practice today only issue
 * filings (`github.create_issue`) carry a captured URL.
 */
export function computePendingConfirmations(
  opts: RunWorkerShadowOpts = {},
): PendingConfirmation[] {
  const home = os.homedir();
  const patchworkDir = opts.patchworkDir ?? path.join(home, ".patchwork");
  const workersDir = opts.workersDir ?? path.join(patchworkDir, "workers");
  // Same PATCHWORK_HOME-aware resolver the write path uses (see slice #3), so
  // the queue reflects exactly what a confirm would write.
  const store = new OutcomeStore(resolveOutcomeLogDir(opts.patchworkDir));
  const workers = loadWorkersFromDir(workersDir);
  // Attribute each run to the FIRST worker declaring its recipe (mirrors the
  // dial's first-match attribution), and read the run log ONCE over the union
  // of recipe names — readRuns already dedups the names — rather than
  // re-parsing the whole log per worker.
  const workerForRecipe = new Map<string, WorkerManifest>();
  for (const w of workers) {
    if (w.recipe && !workerForRecipe.has(w.recipe)) {
      workerForRecipe.set(w.recipe, w);
    }
  }
  const recipeNames = Array.from(workerForRecipe.keys());
  if (recipeNames.length === 0) return []; // no workers → nothing to attribute
  const byUrl = new Map<string, PendingConfirmation>();
  for (const run of readRuns(patchworkDir, recipeNames)) {
    const w = workerForRecipe.get(run.recipeName);
    if (!w) continue;
    for (const step of run.steps) {
      if (!step.tool || step.status !== "ok") continue;
      const ac = classifyActionClass(step.tool);
      if (ac.reversibility === "reversible") continue; // never needs confirming
      const out = step.output as Record<string, unknown> | undefined;
      // Key by the same rule the trust fold uses (#1319). Keying these two
      // differently is the failure this queue exists to prevent: the fold
      // would withhold an action the queue never surfaced for confirmation.
      const actionKey = deriveActionKey(step.tool, out);
      if (!actionKey) continue; // genuinely unreferenceable — nothing to confirm
      const url =
        out && typeof out.url === "string" ? (out.url as string) : undefined;
      const ref = url
        ? undefined
        : { tool: step.tool, id: actionKey.slice(step.tool.length + 1) };
      const title =
        out && typeof out.title === "string" && out.title.trim()
          ? (out.title as string)
          : undefined;
      const disp = store.getDisposition(actionKey);
      if (disp === "confirmed" || disp === "junk") continue; // already actioned
      // unknown / no record → pending. Dedup by key, keep the newest filing.
      const prev = byUrl.get(actionKey);
      if (!prev || run.at > prev.filedAt) {
        byUrl.set(actionKey, {
          actionKey,
          ...(url ? { issueUrl: url } : {}),
          ...(ref ? { ref } : {}),
          recipeName: run.recipeName,
          workerId: w.id,
          workerName: w.name,
          filedAt: run.at,
          classKey: ac.key,
          title,
        });
      }
    }
  }
  return Array.from(byUrl.values()).sort((a, b) => b.filedAt - a.filedAt);
}

/** Human-readable confirm queue for `patchwork outcomes pending`. */
export function formatPendingConfirmations(
  pending: PendingConfirmation[],
  now = Date.now(),
): string {
  if (pending.length === 0) {
    return "No filings awaiting confirmation — every worker filing has an operator disposition.\n";
  }
  const rel = (at: number): string => {
    const ms = Math.max(0, now - at);
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) return "just now";
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };
  const lines = [
    `${pending.length} filing(s) awaiting your confirmation (the confirm queue):`,
    "",
  ];
  for (const p of pending) {
    // The argument the operator must actually type. A URL filing takes the URL
    // positionally; a non-URL one takes --tool/--id. Printing the ready-to-run
    // command matters more than usual here: the id is an opaque connector
    // string nobody can retype from memory.
    const arg = p.ref
      ? `--tool ${p.ref.tool} --id ${p.ref.id}`
      : (p.issueUrl ?? p.actionKey);
    const headline = p.title ?? p.issueUrl ?? p.actionKey;
    lines.push(p.title ? `  "${headline}"` : `  ${headline}`);
    if (p.title && (p.issueUrl || p.ref)) {
      lines.push(`    ${p.issueUrl ?? p.actionKey}`);
    }
    lines.push(
      `    filed by ${p.workerName} (${p.recipeName}) · ${p.classKey} · ${rel(p.filedAt)}`,
    );
    lines.push(
      `    confirm: patchwork outcomes confirm ${arg} --recipe ${p.recipeName} --class ${p.classKey}`,
    );
    lines.push(
      `    reject:  patchwork outcomes reject ${arg} --recipe ${p.recipeName} --class ${p.classKey}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
