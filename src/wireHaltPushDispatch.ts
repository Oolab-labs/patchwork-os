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
}

/**
 * Returns an unsubscribe function. Caller is responsible for
 * cleanup on shutdown (the bridge doesn't typically need to —
 * process exit drops the listener regardless).
 */
export function wireHaltPushDispatch(
  deps: WireHaltPushDispatchDeps,
): () => void {
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
    // Best-effort: dispatchHaltPushNotification swallows errors, but
    // a synchronously-thrown URL parse error would still surface here.
    dispatchHaltPushNotification(cfg.url, cfg.token, {
      recipeName,
      runSeq,
      status: "error",
      errorMessage,
      occurredAt: Date.now(),
    }).catch((err) => {
      deps.logger?.warn?.(
        `[halt-push] unexpected dispatcher error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
}
