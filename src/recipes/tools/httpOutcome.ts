/**
 * httpOutcome — what an `http.post` response means for the STEP that sent it.
 *
 * `http.post` returns `{status, ok, body}` for every final response, and both
 * runners fail a step only when a tool returns `{ok: false, error: <string>}`.
 * A refusal carries no top-level `error` (the target's own error travels
 * inside `body`, as a string), so a 422 that created nothing used to be
 * recorded as a successful step in a clean run.
 *
 * This module is the ONE interpretation of that shape. Both runners, both
 * replay paths, `fan_out` and the trust fold call it, so they cannot drift.
 * Because it reads the `status` the tool has always returned, a response
 * recorded before this module existed is classified the same way on replay.
 *
 * Deliberately specific to `http.post`. It does NOT teach the runners that any
 * `{ok: false}` output is a failure; other tools keep their own contracts.
 *
 * Two claims, and no more:
 *   - `http_rejected`: a 4xx answered by the URL that was posted to. The
 *     target refused the request. That still does not say nothing changed.
 *   - `http_unverified`: every other non-2xx, including a 4xx that arrived
 *     AFTER a redirect. The target reported an error and the resulting
 *     business state is NOT VERIFIED. A 5xx can arrive after the write was
 *     applied, and a 303 turns the POST into a GET whose 401 says nothing
 *     about the write that preceded it, so neither is ever described as
 *     "rejected" or "nothing happened".
 * A 2xx is left alone. That does not make it proof of a completed business
 * outcome (202 Accepted means processing has not finished); it only means the
 * target did not report a failure.
 *
 * Neither failure is ever retried automatically. `http.post` is not
 * idempotent, and repeating a request that may already have been applied is
 * the one thing a truthful failure must not cause.
 */

export const HTTP_REJECTED = "http_rejected";
export const HTTP_UNVERIFIED = "http_unverified";

export type HttpFailureCode = typeof HTTP_REJECTED | typeof HTTP_UNVERIFIED;

export interface HttpStepFailure {
  code: HttpFailureCode;
  status: number;
  /**
   * The step's error text. Starts with `<code>:` so the halt categoriser, the
   * retry loops and the trust fold can recognise it from the persisted
   * sentence alone. The run log keeps the sentence, not a structured field.
   */
  message: string;
}

const HTTP_TOOL = "http.post";
/** The only tools whose `http_*` errors this module produced: `http.post`,
 * and `fan_out`, which classifies its `http.post` iterations. */
const HTTP_FAILURE_TOOLS = new Set([HTTP_TOOL, "fan_out"]);

/**
 * Classify a result produced by `http.post`. `null` for any other tool, for a
 * 2xx, or for anything that is not a recognisable `{status}` response, in
 * which case the caller's existing handling applies unchanged.
 */
export function classifyHttpStepResult(
  tool: string | undefined,
  result: unknown,
): HttpStepFailure | null {
  if (tool !== HTTP_TOOL) return null;
  let parsed: unknown = result;
  if (typeof result === "string") {
    try {
      parsed = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { status, redirected } = parsed as {
    status?: unknown;
    redirected?: unknown;
  };
  if (typeof status !== "number" || !Number.isInteger(status)) return null;
  if (status >= 200 && status < 300) return null;
  if (status >= 400 && status < 500 && redirected !== true) {
    return {
      code: HTTP_REJECTED,
      status,
      message: `${HTTP_REJECTED}: the target rejected the request (HTTP ${status}); not retried`,
    };
  }
  const answer =
    redirected === true
      ? `the target answered HTTP ${status} after a redirect`
      : `the target reported an error (HTTP ${status})`;
  return {
    code: HTTP_UNVERIFIED,
    status,
    message: `${HTTP_UNVERIFIED}: ${answer}; the resulting business state has not been verified; not retried`,
  };
}

/** Body characters kept as evidence of a failed response. Small enough that,
 * even fully JSON-escaped (6x), the capture stays under the run log's 8 KB
 * cap: a capture over it is replaced by a truncation envelope, which loses
 * `status`, which replay and the trust fold both need. */
const EVIDENCE_BODY_CHARS = 1024;

/**
 * What a failed `http.post` leaves in the run row: its status and the start of
 * the target's answer. Anything that is not a recognisable response is
 * returned unchanged.
 */
export function httpFailureEvidence(result: unknown): unknown {
  let parsed: unknown = result;
  if (typeof result === "string") {
    try {
      parsed = JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (parsed === null || typeof parsed !== "object") return result;
  const { status, body, redirected } = parsed as {
    status?: unknown;
    body?: unknown;
    redirected?: unknown;
  };
  if (typeof status !== "number") return result;
  const text = typeof body === "string" ? body : "";
  return {
    status,
    ok: false,
    ...(redirected === true && { redirected: true }),
    body:
      text.length > EVIDENCE_BODY_CHARS
        ? `${text.slice(0, EVIDENCE_BODY_CHARS)}…[truncated]`
        : text,
  };
}

/** True when an error string carries one of this module's codes. Text only:
 * callers that decide anything should use `isHttpFailureFromTool`. */
export function isHttpStepFailure(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error.startsWith(`${HTTP_REJECTED}:`) ||
    error.startsWith(`${HTTP_UNVERIFIED}:`)
  );
}

/**
 * True when a step's error is an HTTP failure this module produced. Keyed on
 * the TOOL as well as the text: any other tool can surface a third party's
 * message verbatim, and a target that answered "http_rejected: …" must not be
 * able to switch off a retry, or exempt a genuine failure from the trust
 * fold.
 */
export function isHttpFailureFromTool(
  tool: string | undefined,
  error: string | undefined,
): boolean {
  return (
    tool !== undefined &&
    HTTP_FAILURE_TOOLS.has(tool) &&
    isHttpStepFailure(error)
  );
}
