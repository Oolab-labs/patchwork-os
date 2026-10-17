/**
 * The deadline for an OAuth token-refresh request.
 *
 * A refresh had no timeout, and `BaseConnector.refreshTokenDeduped` shares
 * one in-flight promise between callers, so a token endpoint that never
 * answered wedged every later call on that connector (audit M24). Every
 * refresh `fetch` passes `tokenRefreshSignal()`; a test asserts it.
 *
 * Deliberately no imports: connectors import this, and it must not pull a
 * connector module back in.
 */

const DEFAULT_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
let overrideMs: number | undefined;

/** An abort signal that fires after the refresh deadline. */
export function tokenRefreshSignal(): AbortSignal {
  return AbortSignal.timeout(overrideMs ?? DEFAULT_TOKEN_REFRESH_TIMEOUT_MS);
}

/** Test hook: shorten the deadline; `undefined` restores the default. */
export function _setTokenRefreshTimeoutForTests(ms: number | undefined): void {
  overrideMs = ms;
}
