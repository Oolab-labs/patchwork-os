/**
 * Subscribe to ActivityLog and dispatch a Web Push notification
 * whenever a recipe run completes with status=error.
 *
 * Lives outside the recipe runner so the runner stays push-agnostic
 * (`yamlRunner.ts` already emits `recipe_done` lifecycle events —
 * we just listen). Pushes are fire-and-forget; runner is never
 * blocked or affected by a relay outage.
 *
 * Reads `pushServiceUrl` / `pushServiceToken` from a getter callback
 * (not a captured value) so config edits through `/settings` take
 * effect immediately without a bridge restart.
 *
 * Dedup: a run that is retried / resumed can emit `recipe_done` more
 * than once. A short-window per-runSeq guard collapses those into a
 * single push so a flapping run can't spam every subscribed device.
 */

import type { ActivityLog } from "./activityLog.js";
import { dispatchHaltPushNotification } from "./haltPushDispatch.js";

interface WireHaltPushDispatchDeps {
  activityLog: ActivityLog;
  /** Called per event — returns the current push relay config or null
   *  if push isn't configured. Reading from a getter rather than a
   *  captured value picks up runtime config changes. */
  getPushConfig: () => { url: string; token: string } | null;
  logger?: { warn?: (msg: string) => void };
  /** Override the dedup window. Default 60_000 ms. Tests pass a small
   *  value; production never sets it. */
  dedupWindowMs?: number;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_DEDUP_WINDOW_MS = 60_000;

export function wireHaltPushDispatch(
  deps: WireHaltPushDispatchDeps,
): () => void {
  const dedupWindowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const now = deps.now ?? Date.now;
  // runSeq → last-dispatched epoch ms. Pruned opportunistically on
  // each event so the Map can't grow unbounded on a long-lived bridge.
  const lastDispatched = new Map<number, number>();

  function prune(cutoff: number): void {
    for (const [seq, at] of lastDispatched) {
      if (at < cutoff) lastDispatched.delete(seq);
    }
  }

  return deps.activityLog.subscribe((kind, entry) => {
    if (kind !== "lifecycle") return;
    const lifecycle = entry as {
      event?: string;
      metadata?: Record<string, unknown>;
    };
    if (lifecycle.event !== "recipe_done") return;
    const md = lifecycle.metadata ?? {};
    if (md.status !== "error") return;

    const cfg = deps.getPushConfig();
    if (!cfg) return;

    const recipeName =
      typeof md.recipeName === "string" ? md.recipeName : "recipe";
    const runSeq = typeof md.runSeq === "number" ? md.runSeq : 0;
    const errorMessage =
      typeof md.errorMessage === "string" ? md.errorMessage : undefined;

    // Dedup: skip if this runSeq fired a push within the window.
    // runSeq 0 is the "unknown" sentinel — never dedup it, since two
    // genuinely distinct unknown-seq runs would otherwise collide.
    const at = now();
    prune(at - dedupWindowMs);
    if (runSeq !== 0) {
      const last = lastDispatched.get(runSeq);
      if (last !== undefined && at - last < dedupWindowMs) return;
      lastDispatched.set(runSeq, at);
    }

    // Best-effort: dispatchHaltPushNotification swallows errors, but
    // a synchronously-thrown URL parse error would still surface here.
    dispatchHaltPushNotification(cfg.url, cfg.token, {
      recipeName,
      runSeq,
      status: "error",
      errorMessage,
      occurredAt: at,
    }).catch((err) => {
      deps.logger?.warn?.(
        `[halt-push] unexpected dispatcher error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
}
