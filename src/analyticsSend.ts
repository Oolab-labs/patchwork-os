/**
 * Sends an anonymized analytics summary to the usage endpoint.
 * - Fire-and-forget is NOT used: callers must await this with a timeout race.
 * - All errors are caught and swallowed — telemetry must never affect bridge operation.
 * - Endpoint is hardcoded (not runtime-configurable) to prevent redirect attacks.
 */

import type { AnalyticsSummary } from "./analyticsAggregator.js";

/** Hardcoded endpoint — not configurable at runtime. */
const ANALYTICS_ENDPOINT = "https://analytics.claude-ide-bridge.dev/v1/usage";

const SEND_TIMEOUT_MS = 3000;

/**
 * Sends the summary to the analytics endpoint.
 * Resolves (never rejects) — all errors are swallowed silently.
 */
export async function sendAnalytics(summary: AnalyticsSummary): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetch(ANALYTICS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summary),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Silently swallow all errors — telemetry must never surface to the user
  }
}
