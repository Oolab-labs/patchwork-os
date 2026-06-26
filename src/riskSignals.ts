import * as path from "node:path";
import type { RiskSignal } from "./approvalQueue.js";
import { classifyTool, type RiskTier } from "./riskTier.js";

/**
 * Command-bearing tools whose params carry a shell command string. Bash /
 * runCommand / runInTerminal expose it as `command`; sendTerminalCommand uses
 * `text`. computeRiskSignals reads whichever is present.
 */
const COMMAND_TOOLS = new Set([
  "Bash",
  "runCommand",
  "runInTerminal",
  "sendTerminalCommand",
]);

/**
 * Content-derived risk signals for an approval request. Pure + synchronous
 * (regex tests + one `path.resolve` + a try/caught `URL` parse), so it is safe
 * to call inside the in-process approval gate's async closure.
 *
 * Single source of truth for BOTH the in-process gate (bridge.ts /
 * streamableHttp.ts) and the CC-native /approvals path (approvalHttp.ts) — so
 * the catalog can never fork (the repo's recurring "incomplete-fix-one-path"
 * failure mode). (audit P0-2)
 */
export function computeRiskSignals(
  toolName: string,
  params: Record<string, unknown>,
  workspace: string,
): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // Destructive flags — shell commands
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd =
      (typeof params.command === "string" && params.command) ||
      (typeof params.text === "string" && params.text) ||
      "";
    if (/\brm\b.*-[a-z]*r[a-z]*f|\brm\b.*-[a-z]*f[a-z]*r/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "rm with -rf flags",
        severity: "high",
      });
    }
    if (/--force\b/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "contains --force flag",
        severity: "medium",
      });
    }
    if (/\bsudo\b/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "runs as sudo",
        severity: "high",
      });
    }
    if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "SQL DROP statement",
        severity: "high",
      });
    }
    if (/\bTRUNCATE\b/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "SQL TRUNCATE statement",
        severity: "medium",
      });
    }
    if (/\bterraform\b[\s\S]*\bdestroy\b/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "terraform destroy",
        severity: "high",
      });
    }
    if (/\bpulumi\b[\s\S]*\bdestroy\b/i.test(cmd)) {
      signals.push({
        kind: "destructive_flag",
        label: "pulumi destroy",
        severity: "high",
      });
    }
    if (/[`$()]\s*|&&|\|\|/.test(cmd)) {
      signals.push({
        kind: "chaining",
        label: "command chaining or substitution",
        severity: "low",
      });
    }
  }

  // Domain reputation — WebFetch / sendHttpRequest
  if (toolName === "WebFetch" || toolName === "sendHttpRequest") {
    const url = typeof params.url === "string" ? params.url : "";
    if (url && !url.startsWith("https://")) {
      signals.push({
        kind: "domain_reputation",
        label: "non-HTTPS URL",
        severity: "medium",
      });
    }
    try {
      const hostname = new URL(url).hostname;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        signals.push({
          kind: "domain_reputation",
          label: "direct IP address",
          severity: "medium",
        });
      }
    } catch {
      // unparseable URL — skip hostname check
    }
  }

  // Path escape — Write / Edit / Read
  if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    const filePath =
      typeof params.file_path === "string" ? params.file_path : "";
    if (filePath) {
      const resolved = path.resolve(filePath);
      const wsRoot = path.resolve(workspace) + path.sep;
      if (!resolved.startsWith(wsRoot)) {
        signals.push({
          kind: "path_escape",
          label: "file path outside workspace",
          severity: "high",
        });
      }
    }
  }

  return signals;
}

export type InProcessGateDecision =
  | { decision: "bypass" }
  | { decision: "queue"; tier: RiskTier; riskSignals: RiskSignal[] };

/**
 * Decide whether an in-process MCP tool call (the bridge's OWN tools) bypasses
 * the approval gate or must queue for human approval, and compute the content
 * risk signals that travel with it. Single source of truth shared by the
 * WebSocket transport (bridge.ts) and the Streamable-HTTP transport
 * (streamableHttp.ts) so the two can't drift — a content-blind copy on one
 * transport would let `rm -rf` gate like `ls` over that transport. (audit P0-2)
 *
 * Semantics are strictly ADDITIVE vs the prior tier-only gate — escalation can
 * only ever turn a bypass into a queue, never the reverse:
 *  - gate "off"  → always bypass (a deliberate, documented full bypass).
 *  - a HIGH-severity content signal forces the queue even for a sub-high base
 *    tier (escalation). High-tier tools queue as before, now WITH their signals.
 *  - gate "high" + sub-high tier + no high signal → bypass (unchanged).
 *  - gate "all" → everything queues (unchanged).
 */
export function evaluateInProcessGate(opts: {
  toolName: string;
  params: Record<string, unknown>;
  gate: "off" | "high" | "all";
  workspace: string;
}): InProcessGateDecision {
  if (opts.gate === "off") return { decision: "bypass" };
  const tier = classifyTool(opts.toolName);
  const riskSignals = computeRiskSignals(
    opts.toolName,
    opts.params,
    opts.workspace,
  );
  const hasHighSeverity = riskSignals.some((s) => s.severity === "high");
  if (opts.gate !== "all" && tier !== "high" && !hasHighSeverity) {
    return { decision: "bypass" };
  }
  return { decision: "queue", tier, riskSignals };
}
