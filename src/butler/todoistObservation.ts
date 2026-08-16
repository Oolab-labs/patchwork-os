/**
 * Todoist observation channel — turns live task state into grader input.
 *
 * The Butler ingester was merged with no way to observe anything, so its
 * shadow ledger was empty and nothing could be measured. This is the first
 * real channel.
 *
 * ## Why a connector query and not a scheduled LLM task
 *
 * A Claude-Desktop scheduled task was the easy route and is the wrong one: an
 * LLM *gathering* observations can report `completed: true` for an errand it
 * never checked. That poisons the trust ledger exactly as the LLM judge did —
 * the one this repo replaced after it flipped verdicts between runs on
 * identical inputs. Every value here comes from an HTTP response.
 *
 * ## The mapping, and the one rule that matters
 *
 *   200 + is_completed   → completed: true         a positive act
 *   200 + !is_completed  → stateObserved: true     open, and we LOOKED
 *   404                  → deleted: true           a positive act
 *   anything else        → nothing at all          NOT an observation
 *
 * That last line is the load-bearing one. 401, 429, 5xx and network failures
 * yield an observation with no `stateObserved` and no `createdAt`, so the
 * grader returns `unknown` / `not-observed` and the fold withholds it.
 *
 * Getting this wrong in either direction is a real harm and they are not
 * symmetric:
 *
 *   - reading a failure as `deleted` manufactures a NEGATIVE against a worker
 *     that did nothing wrong;
 *   - reading a failure as "observed but open" lets the staleness horizon turn
 *     an outage into a negative 14 days later, which is the same harm with a
 *     delay on it.
 *
 * Neither is available here: `unavailable` produces neither field.
 */

import type { TodoistConnector } from "../connectors/todoist.js";
import type { ErrandObservation } from "./outcomeIngester.js";

/** A task the ingester should look up, and the ref its grade is keyed on. */
export interface TodoistErrandRef {
  /** Todoist task id. */
  taskId: string;
  /**
   * Outcome-join key, `canonicalActionRef` form. Passed in rather than derived
   * here: the ref must match what the fold would compute for the action, and
   * re-deriving it in a second place is how two spellings of the same key
   * appear and a confirmation attaches to nothing.
   */
  ref: string;
  /** Recipe that filed it, for attribution during review. */
  recipe?: string;
}

export interface ObservationRun {
  observations: ErrandObservation[];
  /** Refs whose state could not be read, with the reason. Reported, never
   *  silently dropped — a channel that quietly skips failures looks identical
   *  to one with nothing to do. */
  unavailable: { ref: string; reason: string }[];
}

/**
 * Look up each errand's task and build grader input.
 *
 * Sequential rather than parallel: Todoist rate-limits, `rate_limited` maps to
 * `unavailable`, and a burst that trips the limit would convert a working
 * channel into a batch of non-observations. Slow and complete beats fast and
 * blank for a job that runs on a schedule.
 */
export async function observeTodoistErrands(
  connector: Pick<TodoistConnector, "observeTask">,
  refs: readonly TodoistErrandRef[],
): Promise<ObservationRun> {
  const observations: ErrandObservation[] = [];
  const unavailable: { ref: string; reason: string }[] = [];

  for (const { taskId, ref, recipe } of refs) {
    let result: Awaited<ReturnType<TodoistConnector["observeTask"]>>;
    try {
      result = await connector.observeTask(taskId);
    } catch (err) {
      // A throw is not evidence either. The connector is not supposed to
      // throw here, but "it returned a shape we did not expect" must not
      // become a verdict about a worker.
      unavailable.push({
        ref,
        reason: err instanceof Error ? err.message : "threw",
      });
      continue;
    }

    if (result.kind === "deleted") {
      observations.push({ ref, deleted: true, ...(recipe ? { recipe } : {}) });
      continue;
    }
    if (result.kind === "unavailable") {
      unavailable.push({ ref, reason: result.reason });
      continue;
    }
    observations.push({
      ref,
      ...(recipe ? { recipe } : {}),
      completed: result.completed,
      createdAt: result.createdAt,
      // Set ONLY on a real 200. This is what licenses the staleness rule to
      // turn silence into a negative, and silence is only evidence if
      // somebody was listening.
      stateObserved: true,
    });
  }

  return { observations, unavailable };
}
