import type { ApprovalQueue } from "./approvalQueue.js";
import { evaluateRules, loadCcPermissions } from "./ccPermissions.js";
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
 * bridge HTTP server (src/transport.ts) mounts them in a follow-up PR; this
 * file is mount-ready but not yet wired.
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
}

export interface HttpRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
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
    return { status: 200, body: deps.queue.list() };
  }

  if (method === "GET" && path === "/cc-permissions") {
    const rules = (deps.ccLoader ?? loadCcPermissions)(deps.workspace, {
      managedPath: deps.managedSettingsPath,
    });
    return {
      status: 200,
      body: {
        allow: rules.allow,
        ask: rules.ask,
        deny: rules.deny,
        workspace: deps.workspace,
      },
    };
  }

  if (method === "POST" && path === "/approvals") {
    return await handleApprovalRequest(req, deps);
  }

  const approveMatch = /^\/approve\/([A-Za-z0-9-]+)$/.exec(path);
  if (method === "POST" && approveMatch) {
    const callId = approveMatch[1] as string;
    const ok = deps.queue.approve(callId);
    return {
      status: ok ? 200 : 404,
      body: ok ? { decision: "allow", callId } : { error: "unknown callId" },
    };
  }

  const rejectMatch = /^\/reject\/([A-Za-z0-9-]+)$/.exec(path);
  if (method === "POST" && rejectMatch) {
    const callId = rejectMatch[1] as string;
    const ok = deps.queue.reject(callId);
    return {
      status: ok ? 200 : 404,
      body: ok ? { decision: "deny", callId } : { error: "unknown callId" },
    };
  }

  return { status: 404, body: { error: "not found" } };
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

  const emit = (decision: string, reason: string) =>
    deps.onDecision?.("approval_decision", {
      toolName,
      specifier,
      decision,
      reason,
      permissionMode,
      sessionId,
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
  const { callId, promise } = deps.queue.request({
    toolName,
    params,
    tier,
    summary,
    sessionId,
  });
  const outcome = await promise;
  emit(outcome === "approved" ? "allow" : "deny", outcome);
  return {
    status: 200,
    body: {
      decision: outcome === "approved" ? "allow" : "deny",
      reason: outcome,
      callId,
    },
  };
}
