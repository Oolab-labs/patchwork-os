import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_PERSIST_LINES, RecipeRunLog } from "../runLog.js";
import { classifyActionClass } from "./actionClass.js";
import { backtestWorker, formatBacktestReport } from "./backtest.js";
import { OutcomeStore, resolveOutcomeLogDir } from "./outcomeStore.js";
import {
  type DecisionRecord,
  type RunRecord,
  WorkerShadowObserver,
  type WorkerShadowReport,
} from "./shadowObserver.js";
import { buildShadowReport, formatShadowReport } from "./shadowReport.js";
import type { WorkerManifest } from "./worker.js";
import type { WorkerLevelStore } from "./workerLevelStore.js";
import { loadWorkersFromDir } from "./workerLoader.js";

/**
 * I/O entry for the shadow logger: read the REAL logs the bridge already
 * writes — `~/.patchwork/runs.jsonl` (RecipeRunLog → the dial's evidence) and
 * `~/.claude/ide/activity-*.jsonl` (the live gate's approval decisions) — and
 * produce the trust-dial + ramp-vs-gate report. Fully read-only; touches
 * nothing. Empty logs are honest, not an error (new workers have no activity).
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
    const rows = names
      ? names.flatMap((recipe) => log.query({ recipe, limit: 500 }))
      : log.query({ limit: 500 });
    return rows.map((r) => ({
      recipeName: r.recipeName,
      at: r.doneAt ?? r.startedAt ?? r.createdAt,
      steps: (r.stepResults ?? []).map((s) => ({
        tool: s.tool,
        status: s.status,
        haltReason: s.haltReason,
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
// invalidates the entry. `now` isn't part of the key — the two calls a single
// run makes happen milliseconds apart, well inside any durability-window
// boundary, so reusing the first call's `now` for the second is a no-op
// in practice.
interface TrustCacheEntry {
  runsLogMtimeMs: number;
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

  const cacheKey = `${patchworkDir} ${workersDir} ${recipeName}`;
  const runsLogMtimeMs = statMtimeMs(path.join(patchworkDir, "runs.jsonl"));
  const cached = trustCache.get(cacheKey);
  if (cached && cached.runsLogMtimeMs === runsLogMtimeMs) {
    return cached.trust;
  }

  const workers = loadWorkersFromDir(workersDir);
  const trust = ((): RecipeWorkerTrust | null => {
    if (!workers.length) return null;
    // Same durable-outcome labelling as the dial (one source of truth): the live
    // gate must not count a recent non-reversible success that could still be
    // reverted. Real Date.now() in production; tests inject opts.now.
    const observer = new WorkerShadowObserver(workers, {
      now: opts.now ?? Date.now(),
      outcomeStore: new OutcomeStore(resolveOutcomeLogDir(opts.patchworkDir)),
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
    for (const run of runs) observer.ingestRun(run);
    return { worker, store: observer.levelStore };
  })();

  trustCache.set(cacheKey, { runsLogMtimeMs, trust });
  return trust;
}

export function runWorkerShadowReport(opts: RunWorkerShadowOpts = {}): string {
  const data = getWorkerShadowData(opts);
  if (data.workers.length === 0) {
    return `No worker manifests found in ${data.workersDir}.\nAdd *.worker.yaml there (e.g. copy templates/workers/) and re-run.\n`;
  }
  return `${formatShadowReport(data.workers)}\n(scanned ${data.runsScanned} recipe runs, ${data.decisionsScanned} gate decisions · read-only)\n`;
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
  /** The captured filing URL — the confirm key. Today only `github.create_issue`
   *  captures a URL to the run log, so these are issue URLs; a future PR-filing
   *  recipe tool would flow through unchanged. */
  issueUrl: string;
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
      const url =
        out && typeof out.url === "string" ? (out.url as string) : null;
      if (!url) continue;
      const title =
        out && typeof out.title === "string" && out.title.trim()
          ? (out.title as string)
          : undefined;
      const disp = store.getDisposition(url);
      if (disp === "confirmed" || disp === "junk") continue; // already actioned
      // unknown / no record → pending. Dedup by URL, keep the newest filing.
      const prev = byUrl.get(url);
      if (!prev || run.at > prev.filedAt) {
        byUrl.set(url, {
          issueUrl: url,
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
    lines.push(p.title ? `  "${p.title}"` : `  ${p.issueUrl}`);
    if (p.title) lines.push(`    ${p.issueUrl}`);
    lines.push(
      `    filed by ${p.workerName} (${p.recipeName}) · ${p.classKey} · ${rel(p.filedAt)}`,
    );
    lines.push(
      `    confirm: patchwork outcomes confirm ${p.issueUrl} --recipe ${p.recipeName} --class ${p.classKey}`,
    );
    lines.push(
      `    reject:  patchwork outcomes reject ${p.issueUrl} --recipe ${p.recipeName} --class ${p.classKey}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
