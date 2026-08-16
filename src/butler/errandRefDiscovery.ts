/**
 * Find the errands worth observing, from the run log.
 *
 * `patchwork butler observe` takes refs; it does not find them. Supplying them
 * by hand is fine for a demonstration and useless for a cron, so this closes
 * the last gap between "the ingester works" and "the shadow ledger fills".
 *
 * ## The join key is derived, never invented
 *
 * `deriveActionKey` is the same function the trust fold uses. Re-deriving a
 * key here by a different rule — parsing an id out of the output ourselves,
 * synthesising a permalink — would produce refs the fold cannot resolve, and a
 * graded row under an unresolvable key is a measurement of nothing that still
 * inflates the counts somebody reads before deciding to promote.
 *
 * ## Only `tool:id` keys, never URL-shaped ones
 *
 * `deriveActionKey` returns the URL itself when the output carries one, so
 * legacy rows keep joining. A URL is a fine key and a useless task id: there
 * is no Todoist task to look up in it. Those are counted and reported as
 * unusable rather than dropped, because "we found nothing" and "we found
 * things we cannot look up" are different facts about coverage.
 *
 * ## Coverage is genuinely poor, and that is a property of the run log
 *
 * Measured on a real 1129-run log: 1795 step results, 187 successful, and only
 * ELEVEN that yield a join key at all — three of them Todoist. The limit is
 * output capture, not this code. Reporting the ratio matters: a discoverer
 * that silently returns three refs looks identical to one that is broken.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { patchworkHome } from "../patchworkHome.js";
import { deriveActionKey } from "../workers/actionRef.js";
import type { TodoistErrandRef } from "./todoistObservation.js";

/** Tools whose success creates a Todoist task worth grading later. */
const TODOIST_CREATE_TOOLS = new Set(["todoist.create_task"]);

export interface DiscoveryResult {
  refs: TodoistErrandRef[];
  /** Successful Todoist create steps that yielded no usable task id. */
  unkeyable: number;
  /** Steps whose key was URL-shaped — a valid ref, not a task id. */
  urlShaped: number;
  /** Successful steps overall, for the coverage ratio. */
  successfulSteps: number;
}

interface RunRow {
  recipeName?: string;
  stepResults?: { tool?: string; status?: string; output?: unknown }[];
}

/** Both the live log and its rotation archive, newest file last. */
function runLogFiles(dir: string): string[] {
  return [path.join(dir, "runs.jsonl.1"), path.join(dir, "runs.jsonl")].filter(
    (f) => existsSync(f),
  );
}

/**
 * Walk the run log for Todoist errands.
 *
 * Deduped by ref within the walk: one task created once and re-run in a replay
 * would otherwise be observed twice in a single batch, and the ingester counts
 * rows. Across BATCHES nothing is deduped — successive observations over time
 * are exactly what shows an errand going from open to completed.
 */
export function discoverTodoistErrandRefs(
  opts: { dir?: string } = {},
): DiscoveryResult {
  const dir = opts.dir ?? patchworkHome();
  const refs: TodoistErrandRef[] = [];
  const seen = new Set<string>();
  let unkeyable = 0;
  let urlShaped = 0;
  let successfulSteps = 0;

  for (const file of runLogFiles(dir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: RunRow;
      try {
        row = JSON.parse(line) as RunRow;
      } catch {
        // A half-written row from an interrupted append is not evidence of
        // anything; skip it rather than letting one bad line end the walk.
        continue;
      }
      for (const step of row.stepResults ?? []) {
        if (step.status !== "ok") continue;
        successfulSteps++;
        if (!step.tool || !TODOIST_CREATE_TOOLS.has(step.tool)) continue;

        const key = deriveActionKey(step.tool, step.output);
        if (!key) {
          unkeyable++;
          continue;
        }
        if (/^https?:\/\//i.test(key)) {
          // A valid outcome ref, but there is no task id inside it to look up.
          urlShaped++;
          continue;
        }
        // `tool:id` — the id is everything after the FIRST colon, because a
        // tool name cannot contain one and an id might.
        const idx = key.indexOf(":");
        const taskId = idx === -1 ? "" : key.slice(idx + 1);
        if (!taskId) {
          unkeyable++;
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({
          taskId,
          ref: key,
          ...(row.recipeName ? { recipe: row.recipeName } : {}),
        });
      }
    }
  }

  return { refs, unkeyable, urlShaped, successfulSteps };
}

/**
 * Render coverage for a human.
 *
 * States the denominator on purpose. "3 errands found" reads like success;
 * "3 from 187 successful steps" reads like what it is — a run log that mostly
 * does not capture the output a key can be derived from.
 */
export function formatDiscovery(r: DiscoveryResult): string {
  const lines = [
    `[butler] ${r.refs.length} observable errand(s) from ${r.successfulSteps} successful step(s).`,
  ];
  if (r.urlShaped > 0) {
    lines.push(
      `[butler]   ${r.urlShaped} had a URL-shaped key — a valid ref, but no task id to look up.`,
    );
  }
  if (r.unkeyable > 0) {
    lines.push(
      `[butler]   ${r.unkeyable} captured no id at all — nothing to observe.`,
    );
  }
  if (r.refs.length === 0) {
    lines.push(
      "[butler]   Nothing to observe. That is a run-log coverage limit, not",
      "[butler]   an error: a key can only be derived from a captured output.",
    );
  }
  return lines.join("\n");
}
