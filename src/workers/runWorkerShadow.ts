import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_PERSIST_LINES, RecipeRunLog } from "../runLog.js";
import { backtestWorker, formatBacktestReport } from "./backtest.js";
import { OutcomeStore } from "./outcomeStore.js";
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
      outcomeStore: new OutcomeStore(patchworkDir),
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

/**
 * Load the worker that owns `recipeName` (recipe === body) plus its earned-level
 * store, replayed from the same run log the dial uses. Returns null when no
 * worker owns the recipe (the common case — non-worker recipes are unaffected).
 *
 * This is the LIVE-gate entry: `workerGate.decideWorkerAction(worker, tool,
 * params, store)` reads the returned store. It replays the run log on each call
 * (recipe executions are infrequent); a future optimisation could cache it.
 */
export function loadWorkerTrustForRecipe(
  recipeName: string,
  opts: RunWorkerShadowOpts = {},
): RecipeWorkerTrust | null {
  const home = os.homedir();
  const patchworkDir = opts.patchworkDir ?? path.join(home, ".patchwork");
  const workersDir = opts.workersDir ?? path.join(patchworkDir, "workers");

  const workers = loadWorkersFromDir(workersDir);
  if (!workers.length) return null;
  // Same durable-outcome labelling as the dial (one source of truth): the live
  // gate must not count a recent non-reversible success that could still be
  // reverted. Real Date.now() in production; tests inject opts.now.
  const observer = new WorkerShadowObserver(workers, {
    now: opts.now ?? Date.now(),
    outcomeStore: new OutcomeStore(patchworkDir),
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
  const runs = readRuns(patchworkDir, [recipeName]).sort((a, b) => a.at - b.at);
  for (const run of runs) observer.ingestRun(run);
  return { worker, store: observer.levelStore };
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
  const outcomeStore = new OutcomeStore(patchworkDir);
  for (const w of workers) {
    if (!w.recipe) continue;
    const runs = readRuns(patchworkDir, [w.recipe]);
    lines.push(formatBacktestReport(backtestWorker(w, runs, { outcomeStore })));
  }
  return lines.join("\n");
}
