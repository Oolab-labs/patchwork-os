import * as dns from "node:dns/promises";
import * as path from "node:path";
import type { ApprovalQueue, RiskSignal } from "./approvalQueue.js";
import {
  evaluateRules,
  loadCcPermissions,
  loadCcPermissionsAttributed,
} from "./ccPermissions.js";
import { classifyTool } from "./riskTier.js";

// Tools CC allows in plan mode (read-only — no filesystem or network writes).
const PLAN_MODE_READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "LS",
]);

/**
 * HTTP route handlers for the Patchwork approval surface. Pure functions —
 * bridge HTTP server (src/server.ts) mounts them at /approvals, /approve/:id,
 * /reject/:id. Bearer auth is enforced by server.ts before reaching these
 * handlers; approve/reject also accept x-approval-token for the phone path.
 *
 * Routes:
 *   GET    /approvals              → list pending
 *   POST   /approvals              → request approval (called by PreToolUse hook)
 *   POST   /approve/:callId
 *   POST   /reject/:callId
 *
 * The hook flow:
 *   1. Claude Code fires PreToolUse hook (scripts/patchwork-approval-hook.sh)
 *   2. Hook POSTs { toolName, specifier, params, summary } to /approvals
 *   3. Bridge checks CC's settings.json → deny/ask/allow precedence
 *      - deny → respond immediately { decision: "deny" } (hook exits 2)
 *      - allow → respond immediately { decision: "allow" } (hook exits 0)
 *      - ask OR no rule → queue for dashboard, block until decided
 *   4. Dashboard approves/rejects → resolves queue → hook exits
 */

export interface ApprovalHttpDeps {
  queue: ApprovalQueue;
  workspace: string;
  /** Absolute path to a managed settings file (admin-controlled, highest precedence). */
  managedSettingsPath?: string;
  ccLoader?: typeof loadCcPermissions;
  /** Optional hook — called after every approval decision for audit/activity logging. */
  onDecision?: (event: string, meta: Record<string, unknown>) => void;
  /** Optional webhook URL — POST notification dispatched when approval is queued. */
  webhookUrl?: string;
  /** Gate tier — "off" bypasses all queueing; "high" only queues high-tier tools; "all" queues everything. */
  approvalGate?: "off" | "high" | "all";
  /** Push relay service URL (https://). When set, approval tokens are generated and push notifications dispatched. */
  pushServiceUrl?: string;
  /** Bearer token for the push relay service. */
  pushServiceToken?: string;
  /** Public base URL of this bridge (e.g. https://mybridge.example.com). Embedded in push payload as callback base. */
  pushServiceBaseUrl?: string;
}

export interface HttpRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: URLSearchParams;
  /** x-approval-token header value, if present — phone-path auth for approve/reject. */
  approvalToken?: string;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export async function routeApprovalRequest(
  req: HttpRequest,
  deps: ApprovalHttpDeps,
): Promise<HttpResponse> {
  const { method, path } = req;

  if (method === "GET" && path === "/approvals") {
    const sessionId = req.query?.get("session");
    const list = deps.queue.list();
    const filtered = sessionId
      ? list.filter((a) => a.sessionId === sessionId)
      : list;
    return { status: 200, body: filtered };
  }

  if (method === "GET" && path === "/cc-permissions") {
    const rules = (deps.ccLoader ?? loadCcPermissions)(deps.workspace, {
      managedPath: deps.managedSettingsPath,
    });
    const attributed = loadCcPermissionsAttributed(deps.workspace, {
      managedPath: deps.managedSettingsPath,
    });
    return {
      status: 200,
      body: {
        allow: rules.allow,
        ask: rules.ask,
        deny: rules.deny,
        workspace: deps.workspace,
        attributed,
      },
    };
  }

  if (method === "POST" && path === "/approvals") {
    return await handleApprovalRequest(req, deps);
  }

  const approveMatch = /^\/approve\/([A-Za-z0-9-]+)$/.exec(path);
  if (method === "POST" && approveMatch) {
    const callId = approveMatch[1] as string;
    // Phone path: validate single-use approval token if bearer auth wasn't used
    if (req.approvalToken !== undefined) {
      const valid = deps.queue.validateToken(callId, req.approvalToken);
      if (!valid) {
        return {
          status: 401,
          body: { error: "invalid or expired approval token" },
        };
      }
    }
    const ok = deps.queue.approve(callId);
    return {
      status: ok ? 200 : 404,
      body: ok ? { decision: "allow", callId } : { error: "unknown callId" },
    };
  }

  const rejectMatch = /^\/reject\/([A-Za-z0-9-]+)$/.exec(path);
  if (method === "POST" && rejectMatch) {
    const callId = rejectMatch[1] as string;
    // Phone path: validate single-use approval token if bearer auth wasn't used
    if (req.approvalToken !== undefined) {
      const valid = deps.queue.validateToken(callId, req.approvalToken);
      if (!valid) {
        return {
          status: 401,
          body: { error: "invalid or expired approval token" },
        };
      }
    }
    const ok = deps.queue.reject(callId);
    return {
      status: ok ? 200 : 404,
      body: ok ? { decision: "deny", callId } : { error: "unknown callId" },
    };
  }

  return { status: 404, body: { error: "not found" } };
}

/**
 * Blocked IP patterns for SSRF defense.
 * Covers loopback, RFC-1918 private ranges, and link-local.
 */
function isBlockedIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts as [number, number, number, number];
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Dispatch a JSON webhook notification when an approval is queued.
 * Failures are logged but never thrown — webhook errors must not block
 * the approval flow.
 */
async function dispatchApprovalWebhook(
  webhookUrl: string,
  payload: {
    toolName: string;
    tier: string;
    callId: string;
    requestedAt: number;
    expiresAt: number;
    summary?: string;
  },
): Promise<void> {
  // Only HTTPS targets allowed
  if (!webhookUrl.startsWith("https://")) {
    console.warn(
      `[webhook] Rejected non-HTTPS webhook URL: ${webhookUrl.slice(0, 60)}`,
    );
    return;
  }

  let hostname: string;
  try {
    hostname = new URL(webhookUrl).hostname;
  } catch {
    console.warn(`[webhook] Malformed webhook URL — skipping dispatch`);
    return;
  }

  // Reject bare "localhost" hostname before DNS resolution
  if (hostname === "localhost") {
    console.warn(`[webhook] Blocked loopback webhook hostname: ${hostname}`);
    return;
  }

  // Resolve hostname and check resolved IP against blocklist
  try {
    const resolved = await dns.lookup(hostname);
    if (isBlockedIp(resolved.address)) {
      console.warn(
        `[webhook] Blocked private/loopback IP for webhook: ${resolved.address}`,
      );
      return;
    }
  } catch (err) {
    console.warn(
      `[webhook] DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        requestedAt: new Date(payload.requestedAt).toISOString(),
        expiresAt: new Date(payload.expiresAt).toISOString(),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[webhook] Non-2xx response from webhook: ${res.status} ${res.statusText}`,
      );
    }
  } catch (err) {
    console.warn(
      `[webhook] Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch a push notification to the relay service when an approval is queued.
 * Reuses the same SSRF guard as dispatchApprovalWebhook. Fire-and-forget — never throws.
 */
async function dispatchPushNotification(
  pushServiceUrl: string,
  pushServiceToken: string,
  payload: {
    toolName: string;
    tier: string;
    callId: string;
    requestedAt: number;
    expiresAt: number;
    summary?: string;
    riskSignals?: RiskSignal[];
    approvalToken: string;
    bridgeCallbackBase: string;
  },
): Promise<void> {
  if (!pushServiceUrl.startsWith("https://")) {
    console.warn(`[push] Rejected non-HTTPS push service URL`);
    return;
  }
  let hostname: string;
  try {
    hostname = new URL(pushServiceUrl).hostname;
  } catch {
    console.warn(`[push] Malformed push service URL — skipping`);
    return;
  }
  if (hostname === "localhost") {
    console.warn(`[push] Blocked loopback push service hostname`);
    return;
  }
  try {
    const resolved = await dns.lookup(hostname);
    if (isBlockedIp(resolved.address)) {
      console.warn(
        `[push] Blocked private/loopback IP for push service: ${resolved.address}`,
      );
      return;
    }
  } catch (err) {
    console.warn(
      `[push] DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${pushServiceUrl}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pushServiceToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[push] Non-2xx from push relay: ${res.status} ${res.statusText}`,
      );
    }
  } catch (err) {
    console.warn(
      `[push] Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function computeRiskSignals(
  toolName: string,
  params: Record<string, unknown>,
  workspace: string,
): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // Destructive flags — Bash / runCommand
  if (toolName === "Bash" || toolName === "runCommand") {
    const cmd = typeof params.command === "string" ? params.command : "";
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

async function handleApprovalRequest(
  req: HttpRequest,
  deps: ApprovalHttpDeps,
): Promise<HttpResponse> {
  const body = req.body ?? {};
  const toolName = typeof body.toolName === "string" ? body.toolName : "";
  const specifier =
    typeof body.specifier === "string" ? body.specifier : undefined;
  const params =
    typeof body.params === "object" && body.params !== null
      ? (body.params as Record<string, unknown>)
      : {};
  const summary = typeof body.summary === "string" ? body.summary : undefined;
  const permissionMode =
    typeof body.permissionMode === "string" ? body.permissionMode : undefined;
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId : undefined;

  // riskSignals are computed lazily — most short-circuit branches skip the
  // cost by never calling computeRiskSignals. The queue-awaiting branch
  // passes the already-computed signals via the optional arg.
  const emit = (
    decision: string,
    reason: string,
    extras?: {
      riskSignals?: RiskSignal[];
      callId?: string;
    },
  ) =>
    deps.onDecision?.("approval_decision", {
      toolName,
      specifier,
      decision,
      reason,
      permissionMode,
      sessionId,
      ...(summary !== undefined && { summary }),
      ...(extras?.riskSignals &&
        extras.riskSignals.length > 0 && {
          riskSignals: extras.riskSignals,
        }),
      ...(extras?.callId && { callId: extras.callId }),
    });

  if (!toolName) {
    return { status: 400, body: { error: "toolName required" } };
  }

  // CC settings.json precedence
  const rules = (deps.ccLoader ?? loadCcPermissions)(deps.workspace, {
    managedPath: deps.managedSettingsPath,
  });
  const decision = evaluateRules(toolName, specifier, rules);
  if (decision === "deny") {
    emit("deny", "cc_deny_rule");
    return { status: 200, body: { decision: "deny", reason: "cc_deny_rule" } };
  }
  if (decision === "allow") {
    emit("allow", "cc_allow_rule");
    return {
      status: 200,
      body: { decision: "allow", reason: "cc_allow_rule" },
    };
  }

  // Per the permission-modes doc, `dontAsk` is non-interactive: `ask` rules
  // and unmatched tools must auto-deny rather than queue for a dashboard
  // human. Honor that so we don't hang CC on a prompt it will never get.
  if (permissionMode === "dontAsk") {
    emit("deny", "dontAsk_mode");
    return {
      status: 200,
      body: { decision: "deny", reason: "dontAsk_mode" },
    };
  }

  // `auto` mode: CC's classifier owns escalation decisions autonomously.
  // Queuing for a human dashboard would block indefinitely — allow through.
  if (permissionMode === "auto") {
    emit("allow", "auto_mode");
    return {
      status: 200,
      body: { decision: "allow", reason: "auto_mode" },
    };
  }

  // `plan` mode: CC blocks all write operations at its own layer.
  // Read-only tools → allow (CC won't block them anyway).
  // Write/exec tools → deny without queuing (CC would reject the write even
  // if we approved it, so queuing for a human is pointless churn).
  if (permissionMode === "plan") {
    if (PLAN_MODE_READ_TOOLS.has(toolName)) {
      emit("allow", "plan_mode_read");
      return {
        status: 200,
        body: { decision: "allow", reason: "plan_mode_read" },
      };
    }
    emit("deny", "plan_mode_write");
    return {
      status: 200,
      body: { decision: "deny", reason: "plan_mode_write" },
    };
  }

  // Fall through to dashboard approval
  const tier = classifyTool(toolName);

  // Respect approvalGate setting — "off" bypasses, "high" only queues high-tier tools
  const gate = deps.approvalGate ?? "off";
  if (gate === "off") {
    emit("allow", "gate_off");
    return { status: 200, body: { decision: "allow", reason: "gate_off" } };
  }
  if (gate === "high" && tier !== "high") {
    emit("allow", "gate_below_threshold");
    return {
      status: 200,
      body: { decision: "allow", reason: "gate_below_threshold" },
    };
  }

  const riskSignals = computeRiskSignals(toolName, params, deps.workspace);
  const now = Date.now();
  const { callId, approvalToken, promise } = deps.queue.request(
    { toolName, params, tier, summary, sessionId, riskSignals },
    { withToken: !!deps.pushServiceUrl },
  );

  // Fire webhook notification in the background — never block approval flow
  if (deps.webhookUrl) {
    dispatchApprovalWebhook(deps.webhookUrl, {
      toolName,
      tier,
      callId,
      requestedAt: now,
      expiresAt: now + 5 * 60_000,
      summary,
    }).catch(() => {});
  }

  // Fire push notification in the background — phone path
  if (deps.pushServiceUrl && deps.pushServiceToken && approvalToken) {
    dispatchPushNotification(deps.pushServiceUrl, deps.pushServiceToken, {
      toolName,
      tier,
      callId,
      requestedAt: now,
      expiresAt: now + 5 * 60_000,
      summary,
      riskSignals,
      approvalToken,
      bridgeCallbackBase: deps.pushServiceBaseUrl ?? "",
    }).catch(() => {});
  }

  const outcome = await promise;
  emit(outcome === "approved" ? "allow" : "deny", outcome, {
    riskSignals,
    callId,
  });
  return {
    status: 200,
    body: {
      decision: outcome === "approved" ? "allow" : "deny",
      reason: outcome,
      callId,
    },
  };
}
