/**
 * Centralized HTTP error responder for the bridge's plain-`http` route
 * handlers.
 *
 * Replaces the ~96 inline `res.end(JSON.stringify({error: err.message}))`
 * blocks scattered across `server.ts`, `connectorRoutes.ts`,
 * `recipeRoutes.ts`, `inboxRoutes.ts`, and `oauthRoutes.ts` — every one of
 * which leaked the underlying error message (and sometimes a stack frame
 * via `Error.toString`) to the network. CodeQL flagged each as
 * `js/stack-trace-exposure` (89 open alerts at the time of writing).
 *
 * Contract:
 *   - Always returns a generic `{error: "Internal server error"}` body, never
 *     the underlying error.message — even for non-Error throws.
 *   - Logs the full detail (stack preferred, message fallback, String(err)
 *     last) to stderr with an optional context label so post-incident
 *     debugging is unaffected.
 *   - Idempotent on `headersSent` / `writableEnded` so callers nested inside
 *     other try/catch blocks can safely call this without re-throwing.
 *
 * Note: the dashboard's Next.js route handlers (`dashboard/src/app/api/**`)
 * are a separate runtime — they use `NextResponse.json(...)` and have their
 * own (smaller) leak surface; this helper is bridge-side only.
 */

import type { ServerResponse } from "node:http";

const GENERIC_BODY = JSON.stringify({ error: "Internal server error" });

/**
 * Write a generic 500 response and log the underlying error detail
 * server-side.
 *
 * @param res     The Node http response to write to.
 * @param err     The thrown value caught by the route handler.
 * @param context Optional short tag identifying the route ("recipes/lint",
 *                "connectors/jira/connect", etc.). Surfaces in the server
 *                log only — never sent to the client.
 */
export function respond500(
  res: ServerResponse,
  err: unknown,
  context?: string,
): void {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[http-500]${context ? ` ${context}` : ""}: ${detail}`);
  if (!res.headersSent) {
    res.writeHead(500, { "Content-Type": "application/json" });
  }
  if (!res.writableEnded) {
    res.end(GENERIC_BODY);
  }
}
