/**
 * Shared helper for capping incoming proxy request bodies before they get
 * buffered in dashboard heap. Without this, an authenticated caller can
 * stream a multi-GB body through the proxy before the bridge's per-route
 * cap kicks in and rejects it (the bridge cap protects bridge memory, not
 * dashboard memory).
 *
 * Defense layers, in order:
 *   1. Content-Length pre-check — reject obviously oversized declarations
 *      before reading any body bytes (HTTP 413).
 *   2. Streamed accumulation — read chunks, abort + cancel the reader the
 *      moment cumulative bytes exceed the cap. Defeats chunked-encoded
 *      uploads that omit Content-Length.
 *
 * Each proxy route picks a cap from BRIDGE_BODY_CAPS that matches its
 * downstream bridge route. Caps are 2× the bridge cap so legitimate
 * Content-Type / Content-Length / minor-encoding overhead doesn't false-
 * positive (the bridge then enforces the precise limit).
 */

/**
 * Per-route body caps for routes that proxy directly through to the
 * bridge. Each value is 2× the corresponding bridge-side cap in
 * src/recipeRoutes.ts (RECIPE_ROUTE_BODY_CAPS) so the dashboard
 * proxy rejects only obviously oversized payloads and lets the bridge
 * enforce the exact policy.
 *
 * `genericProxy` matches the bridge's streamable HTTP transport limit
 * (src/streamableHttp.ts: BODY_SIZE_LIMIT = 1 MB) — used by the catch-
 * all proxy that handles any path the named routes don't capture.
 */
export const BRIDGE_BODY_CAPS = {
  /** /recipes/install — `{ source: string }`. Bridge cap 4 KB. */
  install: 8 * 1024,
  /** /recipes/generate — NL prompt. Bridge cap 4 KB. */
  generate: 8 * 1024,
  /** /recipes/:name/run — vars envelope. Bridge cap 32 KB. */
  run: 64 * 1024,
  /** /recipes/:name PUT/PATCH, /recipes POST, /recipes/lint — yaml. Bridge cap 256 KB. */
  content: 512 * 1024,
  /** Catch-all [...path] proxy — matches bridge streamable HTTP cap (1 MB). */
  genericProxy: 1 * 1024 * 1024,
} as const;

export type BridgeBodyCapKey = keyof typeof BRIDGE_BODY_CAPS;

/**
 * Per-route body caps for dashboard-native API routes (no bridge proxy).
 * Sized for the legitimate payload shape with generous overhead — these
 * are not 2×-bridge because there is no bridge cap to mirror.
 */
export const DASHBOARD_API_BODY_CAPS = {
  /** /api/bridge/approval-insights/explain-batch — `{tools: string[]}`, ≤100 strings ≤~50 chars each. */
  explainBatch: 16 * 1024,
  /** /api/connector-requests POST — small connector metadata envelope. */
  connectorRequest: 16 * 1024,
  /** /api/push/{subscribe,unsubscribe} — PushSubscription JSON; spec is ~2 KB but allow headroom. */
  push: 16 * 1024,
  /** /api/relay/push — bridge → dashboard relay (callId/toolName/tier/approvalToken/bridgeCallbackBase + optional summary, riskSignals). 8 KB is generous. */
  relayPush: 8 * 1024,
  /** /api/connections/[connector]/connect — OAuth start: redirect target + provider state. */
  connectionsConnect: 32 * 1024,
} as const;

export type DashboardApiBodyCapKey = keyof typeof DASHBOARD_API_BODY_CAPS;

export type ReadBodyResult =
  | { ok: true; body: string }
  | { ok: false };

/**
 * Read a request body up to `maxBytes`, rejecting overflow without
 * letting the buffer grow unbounded. Returns `{ ok: false }` if the
 * request is too large; the caller should respond with 413 via
 * `bodyTooLargeResponse(maxBytes)`.
 *
 * Treats a missing body (no `req.body` stream) as an empty string so
 * callers can pipe the result straight into a fetch() body without
 * branching.
 */
export async function readBodyWithCap(
  req: Request,
  maxBytes: number,
): Promise<ReadBodyResult> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false };
  }
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, body: "" };
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort drain — already over the cap, response is 413
      }
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Standard 413 Payload Too Large response with a hint about the cap.
 * Body is JSON so dashboard fetch wrappers can parse it like any other
 * error response.
 */
export function bodyTooLargeResponse(maxBytes: number): Response {
  return new Response(
    JSON.stringify({
      error: "request body too large",
      maxBytes,
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

export type ReadJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "too_large"; maxBytes: number }
  | { ok: false; reason: "invalid_json" };

/**
 * Read + parse a JSON request body up to `maxBytes`. Returns a
 * discriminated result; the caller chooses the response shape (some
 * routes use `{ok: false, error: ...}`, others use `{error: ...}` —
 * keeping that decision in the route preserves existing API contracts).
 *
 *   const r = await readJsonWithCap<MyShape>(req, CAP);
 *   if (!r.ok) {
 *     if (r.reason === "too_large") return bodyTooLargeResponse(r.maxBytes);
 *     return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
 *   }
 *   // use r.value
 *
 * Empty bodies parse to `undefined` so callers can opt into "body
 * required" by checking `value === undefined`.
 */
export async function readJsonWithCap<T = unknown>(
  req: Request,
  maxBytes: number,
): Promise<ReadJsonResult<T>> {
  const read = await readBodyWithCap(req, maxBytes);
  if (!read.ok) return { ok: false, reason: "too_large", maxBytes };
  if (read.body.length === 0) return { ok: true, value: undefined as T };
  try {
    return { ok: true, value: JSON.parse(read.body) as T };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
