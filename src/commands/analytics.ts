/**
 * `patchwork analytics` CLI — manage the self-hosted telemetry collector config.
 *
 * Replaces the brittle pattern of putting endpoint + secret in a launchd plist.
 * Config lives at ~/.claude/ide/analytics-config.json (mode 0600), read on every
 * send. Env vars still win for headless / CI use.
 */

import {
  clearAnalyticsConfig,
  configPath,
  getAnalyticsConfig,
  setAnalyticsConfig,
} from "../analyticsConfig.js";
import { resolveAnalyticsTarget, sendAnalytics } from "../analyticsSend.js";

const USAGE =
  "Usage: patchwork analytics <subcommand>\n\n" +
  "  show                                  Print active endpoint, key (masked), and source\n" +
  "  configure --endpoint URL [--key KEY]  Write endpoint and/or key to the config file\n" +
  "  clear                                 Remove the config file\n" +
  "  test                                  Send a tiny synthetic payload and report HTTP status\n" +
  "\n" +
  "Resolution order: env (PATCHWORK_ANALYTICS_ENDPOINT/_KEY) > config file > upstream default.\n";

function maskKey(key: string | undefined): string {
  if (!key) return "<unset>";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)} (len=${key.length})`;
}

function parseFlags(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || !a.startsWith("--")) continue;
    const name = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[name] = next;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
}

export async function runAnalyticsCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }

  if (sub === "show") {
    const target = resolveAnalyticsTarget();
    const cfg = getAnalyticsConfig();
    process.stdout.write(
      `Active endpoint:  ${target.endpoint}  (source: ${target.source.endpoint})\n` +
        `Active key:       ${maskKey(target.key)}  (source: ${target.source.key})\n` +
        `Config file:      ${configPath()}\n` +
        `  endpoint:       ${cfg.endpoint ?? "<unset>"}\n` +
        `  key:            ${maskKey(cfg.key)}\n` +
        `Env:\n` +
        `  PATCHWORK_ANALYTICS_ENDPOINT: ${process.env.PATCHWORK_ANALYTICS_ENDPOINT ?? "<unset>"}\n` +
        `  PATCHWORK_ANALYTICS_KEY:      ${maskKey(process.env.PATCHWORK_ANALYTICS_KEY)}\n`,
    );
    return 0;
  }

  if (sub === "configure") {
    const flags = parseFlags(argv.slice(1));
    const update: { endpoint?: string; key?: string } = {};
    if (typeof flags.endpoint === "string") update.endpoint = flags.endpoint;
    if (typeof flags.key === "string") update.key = flags.key;
    if (Object.keys(update).length === 0) {
      process.stderr.write(
        "configure requires at least --endpoint URL or --key KEY\n",
      );
      return 1;
    }
    try {
      setAnalyticsConfig(update);
    } catch (err) {
      process.stderr.write(
        `configure failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    process.stdout.write(`wrote ${configPath()}\n`);
    return 0;
  }

  if (sub === "clear") {
    clearAnalyticsConfig();
    process.stdout.write(`removed ${configPath()}\n`);
    return 0;
  }

  if (sub === "test") {
    const target = resolveAnalyticsTarget();
    process.stdout.write(
      `sending synthetic summary to ${target.endpoint} (key source: ${target.source.key})…\n`,
    );
    // Build minimal real-shaped summary
    const summary = {
      bridgeVersion: "cli-test",
      sessionDurationMs: 1,
      toolStats: [
        { tool: "getDiagnostics", calls: 1, errors: 0, p50Ms: 1, p95Ms: 1 },
      ],
    };
    // sendAnalytics swallows errors, so we shadow it with a direct fetch
    // to surface the actual HTTP status to the operator.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (target.key) headers["X-Analytics-Key"] = target.key;
      const res = await fetch(target.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(summary),
        signal: controller.signal,
      });
      clearTimeout(timer);
      process.stdout.write(`HTTP ${res.status}\n`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (body) process.stdout.write(`body: ${body.slice(0, 500)}\n`);
        return 1;
      }
      // Also exercise the real send path so prefs.lastSentAt updates.
      await sendAnalytics(summary);
      return 0;
    } catch (err) {
      process.stderr.write(
        `test failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  process.stderr.write(`unknown subcommand: ${sub}\n\n${USAGE}`);
  return 1;
}
