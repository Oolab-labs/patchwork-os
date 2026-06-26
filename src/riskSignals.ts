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
    const cmdBase =
      (typeof params.command === "string" && params.command) ||
      (typeof params.text === "string" && params.text) ||
      "";
    // runCommand delivers the subcommand + flags in params.args (its `command`
    // is the bare basename, e.g. "git"); runInTerminal / sendTerminalCommand
    // carry the whole shell string and have no `args`. Join them so every
    // pattern below sees the FULL command for all four tools — otherwise a
    // `git reset --hard` issued as runCommand{command:"git",args:[…]} reduces
    // to "git" and silently matches nothing. (P1-3 / P1-7)
    const argsArr = Array.isArray(params.args)
      ? (params.args as unknown[]).filter(
          (a): a is string => typeof a === "string",
        )
      : [];
    const cmd =
      argsArr.length > 0 ? `${cmdBase} ${argsArr.join(" ")}` : cmdBase;
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
    // Destructive git / system commands — mirrors the SubprocessDriver deny-list
    // (claudeDriver.ts / subprocessSettings.ts). The driver HARD-denies these on
    // its ungated subprocess path; the bridge's gated path escalates them to
    // human approval instead. `--force-with-lease` is intentionally NOT flagged
    // (it is the safe force-push the bridge itself uses). `rm -rf` / `sudo` are
    // already covered above. (audit P1-3)
    if (
      /\bgit\b.*\breset\b.*--hard\b/i.test(cmd) ||
      /\bgit\b.*\bclean\b.*(-[a-z]*f|--force|-d)/i.test(cmd) ||
      /\bgit\b.*\bpush\b.*(--force(?!-with-lease)|(?:^|\s)-f)\b/i.test(cmd) ||
      /\beval\b/i.test(cmd) ||
      /\bchmod\b.*\b777\b/i.test(cmd) ||
      /\bkill\b.*\s-9\b/i.test(cmd) ||
      /\bpkill\b/i.test(cmd)
    ) {
      signals.push({
        kind: "destructive_command",
        label: "destructive git/system command",
        severity: "high",
      });
    }
    // Data exfiltration — a network-egress upload flag co-occurring with a
    // credential-path reference. Near-zero legitimate use at an agent approval
    // gate, so escalate to approval. (audit P1-7)
    const exfilEgress =
      /\bcurl\b.*(-T\b|--upload-file\b|--data(?:-binary)?\s+@|(?:^|\s)-d\s+@)|\bwget\b.*--post-file=/i;
    const credPath =
      /\.ssh\b|\.aws\b|\bid_rsa\b|\bid_ed25519\b|\.env\b|\bcredentials\b|\.npmrc\b|\.netrc\b/i;
    if (exfilEgress.test(cmd) && credPath.test(cmd)) {
      signals.push({
        kind: "data_exfiltration",
        label: "network upload of credential file",
        severity: "high",
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
