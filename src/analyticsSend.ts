/**
 * Sends an anonymized analytics summary to the usage endpoint (opt-in only;
 * the caller checks the preference).
 *
 * - Callers await this with a timeout race; it never rejects.
 * - Endpoint resolution (per call, so config changes apply without restart):
 *     1. env PATCHWORK_ANALYTICS_ENDPOINT (CI / headless / containers)
 *     2. config file ~/.claude/ide/analytics-config.json
 *        (managed by `patchwork analytics configure`)
 *     3. DEFAULT_ANALYTICS_ENDPOINT
 *   Never read from the network or the payload — a redirect attacker cannot
 *   choose where telemetry goes.
 * - Stops, in order: DO_NOT_TRACK (Console Do Not Track convention),
 *   PATCHWORK_TELEMETRY_DEBUG (prints the payload instead of sending), an
 *   engaged write kill switch.
 * - Transport is `safeFetch`, never raw fetch, and never follows redirects.
 *   The default endpoint must resolve to a PUBLIC address; an operator-
 *   configured endpoint may be private or plain http (e.g. a collector on
 *   a private network), because the operator chose it.
 */

import type { AnalyticsSummary } from "./analyticsAggregator.js";
import { getAnalyticsConfig } from "./analyticsConfig.js";
import { recordAnalyticsSent } from "./analyticsPrefs.js";
import { readKillSwitch } from "./governance/killSwitchPolicy.js";
import { type SafeFetchOptions, safeFetch } from "./ssrfGuard.js";

/** The live public collector. The single definition; import it, never copy it. */
export const DEFAULT_ANALYTICS_ENDPOINT =
  "https://analytics.patchworkos.com/v1/usage";

const SEND_TIMEOUT_MS = 3000;

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

  let endpoint = DEFAULT_ANALYTICS_ENDPOINT;
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

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no";
}

/** Why telemetry is suppressed in this environment, or null. */
export function telemetrySuppressed(
  env: NodeJS.ProcessEnv = process.env,
): "do_not_track" | "debug" | null {
  if (truthy(env.DO_NOT_TRACK)) return "do_not_track";
  if (truthy(env.PATCHWORK_TELEMETRY_DEBUG)) return "debug";
  return null;
}

/** Injection seam for tests; production uses the defaults. */
export interface SendDeps {
  fetchImpl?: SafeFetchOptions["fetchImpl"];
  resolveDns?: SafeFetchOptions["resolveDns"];
  killSwitchEngaged?: () => boolean;
  writeDebug?: (line: string) => void;
  onSent?: () => void;
}

/** Sends the summary. Resolves (never rejects) — all errors are swallowed. */
export async function sendAnalytics(
  summary: AnalyticsSummary,
  deps: SendDeps = {},
): Promise<void> {
  try {
    const suppressed = telemetrySuppressed();
    if (suppressed === "do_not_track") return;
    if (suppressed === "debug") {
      (deps.writeDebug ?? ((l) => process.stderr.write(l)))(
        `[telemetry debug — not sent] ${JSON.stringify(summary)}\n`,
      );
      return;
    }
    const engaged = deps.killSwitchEngaged ?? (() => readKillSwitch().engaged);
    if (engaged()) return;

    const { endpoint, key, source } = resolveAnalyticsTarget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (key) headers["X-Analytics-Key"] = key;
      const { response } = await safeFetch(
        endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify(summary),
          signal: controller.signal,
        },
        {
          allowPrivate: source.endpoint !== "default",
          followRedirects: false,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.resolveDns ? { resolveDns: deps.resolveDns } : {}),
        },
      );
      if (response.ok) (deps.onSent ?? recordAnalyticsSent)();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never surface to the user or affect the bridge.
  }
}
