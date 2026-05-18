/**
 * Sends an anonymized analytics summary to the usage endpoint.
 * - Fire-and-forget is NOT used: callers must await this with a timeout race.
 * - All errors are caught and swallowed — telemetry must never affect bridge operation.
 * - Endpoint defaults to the upstream collector. Operators may override via:
 *     1. env: PATCHWORK_ANALYTICS_ENDPOINT  (highest precedence; for CI/headless)
 *     2. config file: ~/.claude/ide/analytics-config.json  (preferred — managed by
 *        `patchwork analytics configure`, keeps secrets out of launchd plists)
 *     3. default upstream collector
 *   Endpoint is resolved per-call (cheap fs read) so live config changes take
 *   effect on the next send without restart. Invalid values fall back through.
 *   Never read from the network or summary payload — preserves the
 *   redirect-attack property the original hardcoded constant was protecting.
 */

import type { AnalyticsSummary } from "./analyticsAggregator.js";
import { getAnalyticsConfig } from "./analyticsConfig.js";
import { recordAnalyticsSent } from "./analyticsPrefs.js";

const DEFAULT_ENDPOINT = "https://analytics.claude-ide-bridge.dev/v1/usage";

function validUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function resolveAnalyticsTarget(): {
  endpoint: string;
  key: string | undefined;
  source: {
    endpoint: "env" | "config" | "default";
    key: "env" | "config" | "none";
  };
} {
  const envEndpoint = validUrl(process.env.PATCHWORK_ANALYTICS_ENDPOINT);
  const envKey = process.env.PATCHWORK_ANALYTICS_KEY;
  const cfg = getAnalyticsConfig();
  const cfgEndpoint = validUrl(cfg.endpoint);

  let endpoint = DEFAULT_ENDPOINT;
  let endpointSource: "env" | "config" | "default" = "default";
  if (envEndpoint) {
    endpoint = envEndpoint;
    endpointSource = "env";
  } else if (cfgEndpoint) {
    endpoint = cfgEndpoint;
    endpointSource = "config";
  }

  let key: string | undefined;
  let keySource: "env" | "config" | "none" = "none";
  if (envKey) {
    key = envKey;
    keySource = "env";
  } else if (cfg.key) {
    key = cfg.key;
    keySource = "config";
  }

  return {
    endpoint,
    key,
    source: { endpoint: endpointSource, key: keySource },
  };
}

const SEND_TIMEOUT_MS = 3000;

/**
 * Sends the summary to the analytics endpoint.
 * Resolves (never rejects) — all errors are swallowed silently.
 */
export async function sendAnalytics(summary: AnalyticsSummary): Promise<void> {
  try {
    const { endpoint, key } = resolveAnalyticsTarget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (key) headers["X-Analytics-Key"] = key;
      const res = await fetch(endpoint, {
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
