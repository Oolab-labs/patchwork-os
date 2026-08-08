/**
 * Typed errors for the Butler stores, so an HTTP route can classify a throw
 * without reading its prose.
 *
 * ## Why this exists
 *
 * Three route handlers did this:
 *
 *     catch (err) {
 *       badRequest(res, err instanceof Error ? err.message : String(err));
 *     }
 *
 * The comment above one of them explains the intent — `remember` throws on
 * caller-fixable input (too long, NUL bytes, confidence out of range), and
 * those are 400s, not 500s. The intent is right and the API is better for
 * echoing the reason. The defect is that the catch is wider than the comment:
 * it also catches an `appendFileSync` failure from the fact store, whose
 * message carries the full `~/.patchwork/butler/facts.jsonl` path, and hands
 * that to the client. CodeQL flags the pattern as `js/stack-trace-exposure`
 * (alert #139).
 *
 * The same file already had a narrower fix — string-match the messages you
 * expect, `respond500` otherwise. That works until somebody adds a validation
 * message to a store, at which point a caller-fixable 400 silently becomes a
 * 500, or worse, an unexpected error starts matching a prefix and leaks. The
 * classification has to travel WITH the error, not be re-derived from its
 * text at the boundary.
 *
 * `src/httpErrorResponse.ts` exists for the same reason at the response end;
 * this is the request end of the same problem.
 *
 * ## The two kinds
 *
 *   - `ButlerValidationError` — the caller sent something this store will
 *     never accept. Safe to echo: the message describes the caller's own
 *     input, never the machine. Route answers 400.
 *   - `ButlerNotFoundError` — the caller named a record that does not exist.
 *     Also safe to echo, and distinct because it is a 404, not a 400. The
 *     seq/id in the message came from the caller.
 *
 * Anything else is unexpected and gets the generic 500 with the detail logged
 * server-side. That is the default, which is the point: a new failure mode is
 * private until somebody decides otherwise.
 */

/** Caller-fixable input. Safe to echo — describes the request, not the host. */
export class ButlerValidationError extends Error {
  readonly kind = "validation" as const;
  constructor(message: string) {
    super(message);
    this.name = "ButlerValidationError";
  }
}

/** A named record does not exist. Safe to echo; answered as 404. */
export class ButlerNotFoundError extends Error {
  readonly kind = "not_found" as const;
  constructor(message: string) {
    super(message);
    this.name = "ButlerNotFoundError";
  }
}

/**
 * Narrowing helpers.
 *
 * These test the `kind` field rather than using `instanceof`, because
 * `instanceof` is unreliable across module-instance boundaries — two copies of
 * this module (a bundled dashboard build, a vendored `src/` in another repo,
 * a vitest module reset) produce classes that are structurally identical and
 * fail `instanceof`. The failure mode of getting that wrong is a validation
 * error silently downgraded to a 500, which is exactly the confusion this
 * module exists to end.
 */
export function isButlerValidationError(
  err: unknown,
): err is ButlerValidationError {
  return (
    err instanceof Error &&
    (err as Partial<ButlerValidationError>).kind === "validation"
  );
}

export function isButlerNotFoundError(
  err: unknown,
): err is ButlerNotFoundError {
  return (
    err instanceof Error &&
    (err as Partial<ButlerNotFoundError>).kind === "not_found"
  );
}
