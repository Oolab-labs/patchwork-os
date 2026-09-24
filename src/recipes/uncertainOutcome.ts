/**
 * Uncertain-outcome marker — "the write MAY have reached its destination".
 *
 * Three questions a failed write step raises, kept separate on purpose:
 *   (a) did execution fail to get a usable result?  — yes; keep the failure
 *       and its transport diagnostics exactly as thrown.
 *   (b) do we know whether the write happened?      — NO; and "no" must be
 *       preserved as uncertainty, never collapsed into "nothing happened".
 *   (c) is another attempt safe?                     — only on an AFFIRMATIVE
 *       basis. A missing status code is not one.
 *
 * Before this module every post-dispatch failure of `http.post` (response
 * lost after the body was read, socket destroyed mid-body, target hanging past
 * the tool's own timeout) surfaced as a generic `request failed: …` string that
 * no retry loop could tell apart from a connection refused. With `retry: 2`
 * the target received the write three times.
 *
 * The representation is a STRUCTURED marker on the thrown error (`outcome:
 * "uncertain"` plus `code: "outcome_uncertain"`), checked by ONE helper that
 * all three runners (flat, chained, fan_out) and the trust fold call. The
 * message ALSO carries the `outcome_uncertain:` token, for the same reason
 * `step_timeout:` does: two of the propagation channels (the chained runner's
 * `StepExecResult.error`, the persisted run-log row) are strings, and a marker
 * that dies at the first `String(err)` protects nothing. The helper checks the
 * structured field first and the token second; neither site matches transport
 * error text.
 *
 * It is a marker for NON-retriability, not a new retry exception: nothing in
 * here decides that a write is safe to re-issue.
 */

export const OUTCOME_UNCERTAIN_CODE = "outcome_uncertain" as const;
export const OUTCOME_UNCERTAIN_TOKEN = `${OUTCOME_UNCERTAIN_CODE}:` as const;

export interface UncertainOutcomeMarker {
  outcome: "uncertain";
  code: typeof OUTCOME_UNCERTAIN_CODE;
}

/**
 * Thrown by a write tool once the request has been handed to the transport
 * and no usable result came back. The `cause` keeps the original transport
 * error (question (a) above) — the marker never replaces the diagnostics.
 */
export class UncertainOutcomeError
  extends Error
  implements UncertainOutcomeMarker
{
  readonly outcome = "uncertain" as const;
  readonly code = OUTCOME_UNCERTAIN_CODE;
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message.startsWith(OUTCOME_UNCERTAIN_TOKEN)
        ? message
        : `${OUTCOME_UNCERTAIN_TOKEN} ${message}`,
      options,
    );
    this.name = "UncertainOutcomeError";
  }
}

/**
 * Stamp the marker onto an error that WRAPS an uncertain one (fan_out's
 * `iter N failed` envelope, a nested recipe's summary), so the property
 * survives re-throwing through a runner that builds its own Error. The
 * message gains the token as well, for the string-only channels.
 */
export function markUncertainOutcome<E extends Error>(
  err: E,
): E & UncertainOutcomeMarker {
  const marked = err as E & { outcome?: string; code?: string };
  marked.outcome = "uncertain";
  marked.code = OUTCOME_UNCERTAIN_CODE;
  if (!err.message.includes(OUTCOME_UNCERTAIN_TOKEN)) {
    marked.message = `${OUTCOME_UNCERTAIN_TOKEN} ${err.message}`;
  }
  return marked as E & UncertainOutcomeMarker;
}

/**
 * The single check every retry loop and the trust fold consults.
 *
 * Accepts whatever the channel carries: a thrown value (the structured fields
 * win), a bare error string (the token), or a record shaped like a step row
 * (`errorCode`, `error`, `haltReason`). Absent every marker it answers
 * `false` — an ordinary failure is NOT uncertain, and the flat/chained
 * runners keep retrying those exactly as before.
 */
export function isUncertainOutcome(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.includes(OUTCOME_UNCERTAIN_TOKEN);
  if (typeof value !== "object") return false;
  const rec = value as {
    outcome?: unknown;
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
    error?: unknown;
    haltReason?: unknown;
  };
  if (rec.outcome === "uncertain") return true;
  if (rec.code === OUTCOME_UNCERTAIN_CODE) return true;
  if (rec.errorCode === OUTCOME_UNCERTAIN_CODE) return true;
  for (const text of [rec.message, rec.error, rec.haltReason]) {
    if (typeof text === "string" && text.includes(OUTCOME_UNCERTAIN_TOKEN))
      return true;
  }
  return false;
}
