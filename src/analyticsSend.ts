/**
 * Sends an anonymized analytics summary to the usage endpoint.
 * - Fire-and-forget is NOT used: callers must await this with a timeout race.
 * - All errors are caught and swallowed — telemetry must never affect bridge operation.
 * - Endpoint defaults to the upstream collector; self-hosters may override at startup
 *   via PATCHWORK_ANALYTICS_ENDPOINT. The value is read once at module load (never
 *   from the network or the summary payload) to preserve the redirect-attack property.
 */

import type { AnalyticsSummary } from "./analyticsAggregator.js";
import { recordAnalyticsSent } from "./analyticsPrefs.js";

const DEFAULT_ENDPOINT = "https://analytics.claude-ide-bridge.dev/v1/usage";

function resolveEndpoint(): string {
  const override = process.env.PATCHWORK_ANALYTICS_ENDPOINT;
  if (!override) return DEFAULT_ENDPOINT;
  try {
    const u = new URL(override);
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return DEFAULT_ENDPOINT;
    return u.toString();
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

const ANALYTICS_ENDPOINT = resolveEndpoint();
const ANALYTICS_KEY = process.env.PATCHWORK_ANALYTICS_KEY;

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
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (ANALYTICS_KEY) headers["X-Analytics-Key"] = ANALYTICS_KEY;
      const res = await fetch(ANALYTICS_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(summary),
        signal: controller.signal,
      });
      if (res.ok) {
        recordAnalyticsSent();
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Silently swallow all errors — telemetry must never surface to the user
  }
}
