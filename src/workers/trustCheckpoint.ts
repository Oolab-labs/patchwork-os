import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkerLevelStore } from "./workerLevelStore.js";

/**
 * Durable trust evidence — the checkpoint `WorkerLevelStore` never had.
 *
 * The store is pure and in-memory by design, and that design was right: the
 * graduation maths stays testable without touching a disk. What was missing is
 * the other half. `toJSONL()` existed and **nothing in production ever called
 * it**, so every `patchwork workers shadow` run rebuilt a worker's dial by
 * replaying `~/.patchwork/runs.jsonl` and then dropped it. A worker's earned
 * trust therefore lived only inside whatever that log still happened to hold.
 *
 * Run logs rotate. When they do, the evidence rotates with them and a worker is
 * quietly un-earned — with no event, because nothing observed the loss. On
 * 2026-08-10 the live logs held 75 confirmed outcomes across 4 distinct issues
 * and none of those four URLs appeared anywhere in the 773-run log they had to
 * join against, which is one concrete reason the ramp has never graduated
 * anything.
 *
 * ## Why a watermark, and why an id set beside it
 *
 * A checkpoint alone is not enough, because the observer still replays the run
 * log on the next invocation. Re-folding runs already in the checkpoint would
 * inflate a dial toward autonomy on no new evidence — a failure that is
 * strictly worse than the one being fixed, since losing trust fails CLOSED and
 * double-counting fails OPEN.
 *
 * `RunRecord` has no unique id (`recipeName` + `at` is all there is), so the
 * watermark is the newest `at` folded so far. A bare `at > watermark` test
 * would be wrong in one direction: two runs in the same millisecond are
 * ordinary when a cron fires several recipes at once, and the second would be
 * silently dropped forever. So the boundary millisecond additionally carries
 * the exact run keys already seen. Anything older than the watermark is
 * skipped; anything at it is skipped only if its key is already recorded.
 *
 * ## Fail-soft, deliberately
 *
 * A missing or corrupt checkpoint yields *no history* rather than an error.
 * Losing trust is recoverable — the observer re-earns it by replay — whereas
 * refusing to start strands the gate. A partially-parsed file is rejected
 * whole for the same reason it is tempting to salvage: half a checkpoint can
 * restore a LEVEL without the events that justify it, which is precisely the
 * shape of an unearned promotion.
 */

/**
 * Checkpoint path for ONE recipe.
 *
 * Deliberately per-recipe rather than one shared file. The live-gate entry
 * (`loadWorkerTrustForRecipe`) replays only the runs of the recipe it was asked
 * about, so a single global watermark would be advanced past every OTHER
 * recipe's runs by whichever recipe happened to be evaluated first — starving
 * the rest of evidence they had earned. That failure would be invisible: the
 * dial simply never moves for the unlucky workers.
 */
export function trustCheckpointPathFor(
  patchworkDir: string,
  recipeName: string,
): string {
  const safe = recipeName.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(patchworkDir, "worker_trust", `${safe}.jsonl`);
}

/** The replay boundary: everything at or below this is already folded in. */
export interface TrustWatermark {
  /** Newest run `at` (epoch ms) folded into the checkpoint. */
  watermarkAt: number;
  /** Run keys seen at exactly `watermarkAt` — see the module note. */
  idsAtWatermark: string[];
}

export interface LoadedCheckpoint extends TrustWatermark {
  store: WorkerLevelStore;
}

/** Identity of a run for dedup purposes. `RunRecord` carries nothing better. */
export function runKey(run: { recipeName: string; at: number }): string {
  return `${run.recipeName}@${run.at}`;
}

/**
 * Whether `run` is new evidence relative to `cp`. Pure — the caller supplies
 * the checkpoint, so this stays testable without a disk.
 */
export function shouldIngestRun(
  run: { recipeName: string; at: number },
  cp: TrustWatermark,
): boolean {
  if (run.at < cp.watermarkAt) return false;
  if (run.at === cp.watermarkAt)
    return !cp.idsAtWatermark.includes(runKey(run));
  return true;
}

/** Fold a newly-ingested run into a watermark, returning the advanced one. */
export function advanceWatermark(
  cp: TrustWatermark,
  run: { recipeName: string; at: number },
): TrustWatermark {
  if (run.at > cp.watermarkAt) {
    return { watermarkAt: run.at, idsAtWatermark: [runKey(run)] };
  }
  if (run.at === cp.watermarkAt && !cp.idsAtWatermark.includes(runKey(run))) {
    return {
      watermarkAt: cp.watermarkAt,
      idsAtWatermark: [...cp.idsAtWatermark, runKey(run)],
    };
  }
  return cp;
}

const EMPTY = (): LoadedCheckpoint => ({
  store: new WorkerLevelStore(),
  watermarkAt: 0,
  idsAtWatermark: [],
});

/** Read a checkpoint. Missing or unparseable ⇒ no history (never throws). */
export function loadTrustCheckpoint(file: string): LoadedCheckpoint {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return EMPTY(); // never checkpointed, or unreadable — same answer
  }
  try {
    let watermarkAt = 0;
    let idsAtWatermark: string[] = [];
    const rest: string[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.rec === "meta") {
        watermarkAt = typeof obj.watermarkAt === "number" ? obj.watermarkAt : 0;
        idsAtWatermark = Array.isArray(obj.idsAtWatermark)
          ? (obj.idsAtWatermark as string[])
          : [];
        continue;
      }
      rest.push(t);
    }
    return {
      store: WorkerLevelStore.fromJSONL(rest.join("\n")),
      watermarkAt,
      idsAtWatermark,
    };
  } catch {
    // Rejected whole rather than salvaged: a half-read checkpoint can restore a
    // level without the events that earned it.
    return EMPTY();
  }
}

/** Write a checkpoint atomically (tmp + rename), creating the dir if needed. */
export function saveTrustCheckpoint(
  file: string,
  store: WorkerLevelStore,
  watermark: TrustWatermark,
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const meta = JSON.stringify({ rec: "meta", ...watermark });
  const body = store.toJSONL();
  const tmp = `${file}.tmp`;
  // Atomic: a reader never sees a half-written checkpoint, which would be
  // indistinguishable from corruption and discard real evidence.
  writeFileSync(tmp, body ? `${meta}\n${body}\n` : `${meta}\n`, "utf8");
  renameSync(tmp, file);
}
