/**
 * In-memory last-successful-call tracker, keyed by `providerName`.
 *
 * Minimal tracking to answer "when did this connector last do something
 * that worked?" for the dashboard connections card (dashboard gap #2,
 * docs/dashboard-gap-assessment-2026-07-03.md section B.2). Deliberately
 * process-local and non-persistent — a bridge restart resets it, which is
 * fine: the value is "since bridge came up", not a durable audit trail
 * (the Decision Record / gate-decisions log already owns durable history).
 *
 * Recorded from `BaseConnector.apiCall()` on every successful call, so
 * every connector extending BaseConnector gets this for free with no
 * per-connector wiring.
 */

const lastSuccessByProvider = new Map<string, Date>();

/** Record that `providerName` just completed a successful API call. */
export function recordConnectorSuccess(providerName: string): void {
  lastSuccessByProvider.set(providerName, new Date());
}

/**
 * Last successful call timestamp for `providerName`, or `undefined` if
 * none has been recorded (never called, or bridge restarted since).
 * Never fabricated — absence means "we don't know", not "never".
 */
export function getLastConnectorSuccess(
  providerName: string,
): Date | undefined {
  return lastSuccessByProvider.get(providerName);
}

/** Test-only: reset all tracked state between test cases. */
export function __resetConnectorActivityForTest(): void {
  lastSuccessByProvider.clear();
}
