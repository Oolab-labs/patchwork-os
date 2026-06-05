/**
 * wrapConnectorExecute — soft error-envelope normalization for connector tools.
 *
 * Many newer connector tools (monday, stripe, twilio, …) have no try/catch in
 * their `execute()` body. A connector throw — a network failure, a missing-token
 * `authenticate()`/`loadTokens()` error inside a class-accessor connector, etc. —
 * then propagates uncaught. The recipe runner treats an uncaught throw as a
 * null result: `ctx[step.into]` is never written, downstream
 * `{{steps.X.field}}` references resolve empty, and the run halts.
 *
 * The early connector tools (slack.ts, linear.ts, jira.ts) instead return a
 * SOFT error envelope — `JSON.stringify({ ok: false, error })` — so a
 * downstream step can read `.error` and the run can continue.
 *
 * This helper brings throwing tools up to that same standard: it runs the tool
 * body and, on throw, returns the identical envelope. The success path is
 * passed through verbatim (string or null).
 */

import type { ToolContext, ToolExecute } from "../toolRegistry.js";

/**
 * Wrap a connector tool's execute fn so any thrown error becomes the soft
 * error envelope `{ ok: false, error }` (matching slack/linear/jira), instead
 * of propagating and halting the run. Success path is unchanged.
 */
export function wrapConnectorExecute(inner: ToolExecute): ToolExecute {
  return async (context: ToolContext): Promise<string | null> => {
    try {
      return await inner(context);
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
