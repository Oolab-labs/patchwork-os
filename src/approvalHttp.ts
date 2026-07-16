import * as dns from "node:dns/promises";
import {
  recordApprovalCompleted,
  recordApprovalPrompted,
} from "./activationMetrics.js";
import type {
  ApprovalDecision,
  ApprovalQueue,
  RiskSignal,
} from "./approvalQueue.js";
import { computePersonalSignals } from "./approvalSignals.js";
import {
  evaluateRules,
  loadCcPermissions,
  loadCcPermissionsAttributed,
} from "./ccPermissions.js";
import { captureForRunlog } from "./recipes/stepObservation.js";
import { computeRiskSignals } from "./riskSignals.js";
import type { RiskTier } from "./riskTier.js";
import { classifyTool } from "./riskTier.js";
import { isPrivateHost } from "./ssrfGuard.js";

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
  /**
   * Skip the SSRF private/CGNAT-range block for `pushServiceUrl` specifically.
   * Off by default — the guard treats a private-range push relay the same as
   * any other SSRF target. Set when the operator has deliberately pointed
   * `pushServiceUrl` at a private/CGNAT host they control (e.g. a Tailscale
   * `*.ts.net` address, 100.64.0.0/10), mirroring
   * `--automation-allow-private-webhooks` for the automation webhook fan-out.
   */
  pushServiceAllowPrivate?: boolean;
  /**
   * ntfy.sh topic for direct phone-path approvals via action buttons. When set
   * AND `pushServiceBaseUrl` is set (so the action URLs can reach the bridge),
   * each queued approval is published to the topic with Approve / Reject HTTP
   * action buttons that POST back to the bridge with the single-use approval
   * token. Independent of `pushServiceUrl` — ntfy can be the sole phone path
   * (no FCM/APNS relay needed) or run alongside it.
   */
  ntfyTopic?: string;
  /**
   * ntfy server. Defaults to `https://ntfy.sh`. Set to a self-hosted instance
   * (e.g. `https://ntfy.your-domain.tld`) for auth/private-topic deployments.
   */
  ntfyServer?: string;
  /**
   * Optional ActivityLog used to compute passive risk personalization
   * signals (`src/approvalSignals.ts`). When omitted, personalSignals are
   * not computed and the queue entry has the `personalSignals` field
   * absent entirely (distinguishable from `personalSignals: []` which means
   * "wire is live, just no history yet") —
   * the rest of the approval flow is unaffected. Tests that care only about
   * the policy-engine path can leave this off.
   */
  activityLog?: import("./activityLog.js").ActivityLog;
  /**
   * Optional recipe-run log used by the "recipe-step trust" heuristic
   * (h6 in `src/approvalSignals.ts`). When omitted, h6 is silently
   * skipped — the other 11 heuristics still compute over `activityLog`.
   * Wired by bridge.ts when a recipe orchestrator is active.
   */
  recipeRunLog?: import("./approvalSignals.js").RecipeRunQuerier;
  /**
   * Opt-in switch for personalSignals heuristic 10 (time-of-day
   * anomaly). When true and `activityLog` is wired, h10 fires on calls
   * outside the user's usual hours for that tool. Default false —
   * catalog flags h10 as medium-FP for power users with irregular
   * schedules.
   */
  enableTimeOfDayAnomaly?: boolean;
  /**
   * M23: HMAC secret for signing ntfy callback URLs. When set, the approval
   * token is NOT embedded in ntfy action headers (visible to all topic
   * subscribers). Instead, callback URLs carry an HMAC-SHA256 `sig` param
   * computed over `"${action}:${callId}"` with this secret. The approve/reject
   * handlers verify the signature before accepting the request.
   * Recommend: set to the bridge auth token (`lockFile.authToken`).
   */
  ntfyHmacSecret?: string;
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

export interface SseWriter {
  write(data: string): boolean;
  writableEnded: boolean;
  on(event: "close", fn: () => void): void;
  writeHead(status: number, headers: Record<string, string>): void;
}

/**
 * Mount SSE stream for live approval queue updates on `GET /approvals/stream`.
 * Sends the full queue snapshot as a `snapshot` event on connect, then a
 * `update` event whenever the queue changes (enqueue, approve, reject, expire).
 * Heartbeat comment every 15s keeps the connection alive through proxies.
 */
export function handleApprovalsStream(
  res: SseWriter,
  deps: Pick<ApprovalHttpDeps, "queue">,
  sessionFilter?: string | null,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  function sendSnapshot() {
    if (res.writableEnded) return;
    const list = deps.queue.list();
    const filtered = sessionFilter
      ? list.filter((a) => a.sessionId === sessionFilter)
      : list;
    res.write(`event: snapshot\ndata: ${JSON.stringify(filtered)}\n\n`);
  }

  sendSnapshot();

  const unsubscribe = deps.queue.subscribe(() => {
    if (res.writableEnded) {
      unsubscribe();
      return;
    }
    const list = deps.queue.list();
    const filtered = sessionFilter
      ? list.filter((a) => a.sessionId === sessionFilter)
      : list;
    res.write(`event: update\ndata: ${JSON.stringify(filtered)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      unsubscribe();
      return;
    }
    res.write(": heartbeat\n\n");
  }, 15_000);

  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
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
    // M23: when ntfyHmacSecret is configured, verify the HMAC sig query param
    // instead of (or in addition to) the x-approval-token header. The sig is
    // HMAC-SHA256(secret, "approve:callId") so the approval token never appears
    // in the ntfy notification body that all topic subscribers can read.
    const ntfySig = req.query?.get("sig") ?? undefined;
    if (deps.ntfyHmacSecret && ntfySig !== undefined) {
      const { createHmac, timingSafeEqual } = await import("node:crypto");
      const expected = createHmac("sha256", deps.ntfyHmacSecret)
        .update(`approve:${callId}`)
        .digest("hex");
      const sigBuf = Buffer.from(
        ntfySig.length === expected.length ? ntfySig : "",
        "hex",
      );
      const expBuf = Buffer.from(expected, "hex");
      const valid =
        sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
      if (!valid) {
        return {
          status: 401,
          body: { error: "invalid ntfy callback signature" },
        };
      }
    } else if (ntfySig !== undefined) {
      // Tier-0 #1 (audit 2026-06-22): a sig was presented but no ntfyHmacSecret
      // is configured to verify it against. server.ts bypasses the Bearer gate
      // for /approve|reject whenever a ?sig= is present, so falling through here
      // would call queue.approve() UNAUTHENTICATED. Fail closed instead.
      return {
        status: 401,
        body: {
          error:
            "ntfy callback signature rejected: no signing secret configured",
        },
      };
    } else if (req.approvalToken !== undefined) {
      // Phone path: validate single-use approval token when one was provided.
      // This check runs regardless of whether Bearer auth also passed — a caller
      // presenting an approvalToken must have a valid one even when they hold a
      // valid Bearer credential (LOW #18: Bearer must not bypass the token check).
      const valid = deps.queue.validateToken(callId, req.approvalToken);
      if (!valid) {
        return {
          status: 401,
          body: { error: "invalid or expired approval token" },
        };
      }
    }
    // Capture the entry BEFORE resolving (approve() removes it). `toolName`
    // keys the worker shadow logger's ramp-vs-gate attribution; `requestedAt`
    // is the prompt time the considered-approval KPI needs to derive
    // latency-to-decision (this dashboard/phone path is where worker-gate
    // approvals actually land — handleApprovalRequest is the separate CC-hook
    // path).
    const approveEntry = deps.queue.list?.().find((e) => e.callId === callId);
    const approveToolName = approveEntry?.toolName;
    const approveRequestedAt = approveEntry?.requestedAt;
    const approveRecipeName = approveEntry?.recipeName;
    const ok = deps.queue.approve(callId);
    if (ok) {
      // Audit 2026-06-03 (MEDIUM #27): fire the audit hook on APPROVE too —
      // previously only the reject path called onDecision, so approvals (the
      // higher-risk decision) left no audit/activity-log trail.
      deps.onDecision?.("approval_decision", {
        callId,
        decision: "allow",
        // Provenance (audit 2026-06-09): which path the human decided from.
        // A single-use approvalToken ⇒ phone (ntfy/push action button);
        // otherwise a Bearer-authenticated HTTP caller — the dashboard
        // approval UI in practice. Lets the audit log answer "approved from
        // where", not just "who/what/when".
        channel: req.approvalToken !== undefined ? "phone" : "dashboard",
        ...(approveToolName !== undefined && { toolName: approveToolName }),
        ...(approveRequestedAt !== undefined && {
          requestedAt: approveRequestedAt,
        }),
        // Worker-shadow attribution: recipeName lets the shadow observer
        // filter out Claude-session tool calls (which also emit
        // approval_decision but are NOT worker-gate decisions).
        ...(approveRecipeName !== undefined && {
          recipeName: approveRecipeName,
        }),
      });
      return { status: 200, body: { decision: "allow", callId } };
    }
    // Distinguish "callId never existed" from "callId was decided by a
    // concurrent counter-action" so the losing UI converges instead of
    // showing a generic 404. Audit 2026-05-17.
    const prior = deps.queue.getRecentDecision(callId);
    if (prior) {
      return {
        status: 409,
        body: { error: "already_decided", decision: prior, callId },
      };
    }
    return { status: 404, body: { error: "unknown callId" } };
  }

  const rejectMatch = /^\/reject\/([A-Za-z0-9-]+)$/.exec(path);
  if (method === "POST" && rejectMatch) {
    const callId = rejectMatch[1] as string;
    // M23: mirror the HMAC sig verification from the approve path.
    const ntfySig = req.query?.get("sig") ?? undefined;
    if (deps.ntfyHmacSecret && ntfySig !== undefined) {
      const { createHmac, timingSafeEqual } = await import("node:crypto");
      const expected = createHmac("sha256", deps.ntfyHmacSecret)
        .update(`reject:${callId}`)
        .digest("hex");
      const sigBuf = Buffer.from(
        ntfySig.length === expected.length ? ntfySig : "",
        "hex",
      );
      const expBuf = Buffer.from(expected, "hex");
      const valid =
        sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
      if (!valid) {
        return {
          status: 401,
          body: { error: "invalid ntfy callback signature" },
        };
      }
    } else if (ntfySig !== undefined) {
      // Tier-0 #1 (audit 2026-06-22): mirror the approve path — a sig presented
      // without a configured ntfyHmacSecret cannot be verified, and server.ts
      // bypassed the Bearer gate to get here. Fail closed rather than fall
      // through to an unauthenticated queue.reject().
      return {
        status: 401,
        body: {
          error:
            "ntfy callback signature rejected: no signing secret configured",
        },
      };
    } else if (req.approvalToken !== undefined) {
      // Phone path: validate single-use approval token when one was provided.
      // This check runs regardless of whether Bearer auth also passed — a caller
      // presenting an approvalToken must have a valid one even when they hold a
      // valid Bearer credential (LOW #18: Bearer must not bypass the token check).
      const valid = deps.queue.validateToken(callId, req.approvalToken);
      if (!valid) {
        return {
          status: 401,
          body: { error: "invalid or expired approval token" },
        };
      }
    }
    // Optional rejection reason — surfaced on the audit decision event so
    // operators have provenance for high-tier denials. Capped at 500 chars
    // and trimmed; non-strings or empties drop to undefined.
    let reason: string | undefined;
    const raw = (req.body as Record<string, unknown> | undefined)?.reason;
    if (typeof raw === "string") {
      const trimmed = raw.trim().slice(0, 500);
      if (trimmed.length > 0) reason = trimmed;
    }
    // L4: capture toolName before reject() removes the entry (worker shadow
    // attribution keys off it); requestedAt feeds the considered-approval KPI's
    // latency-to-decision.
    const rejectEntry = deps.queue.list?.().find((e) => e.callId === callId);
    const rejectToolName = rejectEntry?.toolName;
    const rejectRequestedAt = rejectEntry?.requestedAt;
    const rejectRecipeName = rejectEntry?.recipeName;
    const ok = deps.queue.reject(callId);
    if (ok) {
      deps.onDecision?.("approval_decision", {
        callId,
        decision: "deny",
        ...(reason !== undefined && { reason }),
        // Provenance: phone (single-use token) vs dashboard/Bearer caller.
        channel: req.approvalToken !== undefined ? "phone" : "dashboard",
        ...(rejectToolName !== undefined && { toolName: rejectToolName }),
        ...(rejectRequestedAt !== undefined && {
          requestedAt: rejectRequestedAt,
        }),
        ...(rejectRecipeName !== undefined && {
          recipeName: rejectRecipeName,
        }),
      });
      return { status: 200, body: { decision: "deny", callId } };
    }
    const prior = deps.queue.getRecentDecision(callId);
    if (prior) {
      return {
        status: 409,
        body: { error: "already_decided", decision: prior, callId },
      };
    }
    return { status: 404, body: { error: "unknown callId" } };
  }

  return { status: 404, body: { error: "not found" } };
}

/**
 * Blocked IP patterns for SSRF defense (loopback, RFC-1918, link-local, ULA,
 * IPv4-mapped IPv6, 6to4-wrapped private, etc.).
 *
 * Delegates to the shared, tested `isPrivateHost` (audit 2026-06-03 HIGH #5).
 * The previous hand-rolled version split on "." and `Number()`-coerced the
 * parts, so IPv4-mapped IPv6 (`::ffff:127.0.0.1` → `Number("::ffff:127")`=NaN)
 * and every native IPv6 private range silently bypassed the guard.
 */
function isBlockedIp(ip: string): boolean {
  return isPrivateHost(ip);
}

/**
 * Resolve a hostname and return true if it should be blocked for SSRF defense.
 *
 * Audit 2026-06-03 (MEDIUM #26): resolve ALL addresses (`{ all: true }`) and
 * block if ANY is private. The previous single-address `dns.lookup(hostname)`
 * checked only the first result, so split-horizon DNS could return a public
 * address to the guard while the subsequent `fetch` resolved a private one.
 * DNS-resolution failure is treated as blocked (fail-closed), matching the
 * prior per-site catch-and-skip behavior. `label` (when set) reproduces the
 * per-dispatcher warn messages.
 */
async function hostResolvesToBlockedIp(
  hostname: string,
  label?: string,
): Promise<boolean> {
  let resolved: Array<{ address: string }>;
  try {
    const r = await dns.lookup(hostname, { all: true });
    // `{ all: true }` always yields an array; coerce defensively so a single
    // LookupAddress (e.g. a test mock that forgot the array) can't throw on
    // `.find` and silently fail open vs closed.
    resolved = Array.isArray(r) ? r : [r as { address: string }];
  } catch (err) {
    if (label)
      console.warn(
        `[${label}] DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
      );
    return true;
  }
  const blocked = resolved.find((r) => isBlockedIp(r.address));
  if (blocked) {
    if (label)
      console.warn(
        `[${label}] Blocked private/loopback IP: ${blocked.address}`,
      );
    return true;
  }
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

  // Resolve hostname and check EVERY resolved IP against the blocklist.
  if (await hostResolvesToBlockedIp(hostname, "webhook")) return;

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
  allowPrivate: boolean = false,
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
  if (!allowPrivate && (await hostResolvesToBlockedIp(hostname, "push")))
    return;

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

/**
 * Tell the push relay to dismiss a previously-sent approval notification.
 * Fired when a pending entry resolves via a path other than the phone tap
 * itself — gate downgraded to "off" (`ApprovalQueue.cancelAll()`) or bridge
 * shutdown — so a stale "tap to approve" card doesn't sit on the lock
 * screen forever for a decision that's already moot. Same SSRF guard and
 * fire-and-forget contract as `dispatchPushNotification`; a failed dismiss
 * just means the notification lingers until the user dismisses it by hand,
 * it never blocks the cancellation itself.
 */
export async function dispatchCancelPush(
  pushServiceUrl: string,
  pushServiceToken: string,
  callId: string,
  allowPrivate: boolean = false,
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
  if (!allowPrivate && (await hostResolvesToBlockedIp(hostname, "push")))
    return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${pushServiceUrl}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pushServiceToken}`,
      },
      body: JSON.stringify({ kind: "cancel", callId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[push] Non-2xx from push relay (cancel): ${res.status} ${res.statusText}`,
      );
    }
  } catch (err) {
    console.warn(
      `[push] Cancel dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish an approval prompt to ntfy.sh with Approve / Reject HTTP action
 * buttons that POST back to the bridge using the single-use approval token.
 * Reuses the same SSRF guard as the push relay path. Fire-and-forget.
 *
 * Action buttons embed the token in the `x-approval-token` header (not the
 * URL), matching the existing relay → service-worker → bridge contract so the
 * single-use token never appears in logs or referrer.
 */
async function dispatchNtfyApproval(
  ntfyServer: string,
  payload: {
    topic: string;
    toolName: string;
    tier: string;
    callId: string;
    summary?: string;
    approvalToken: string;
    bridgeCallbackBase: string;
    /** M23: when set, sign callback URLs with HMAC instead of embedding token in headers */
    hmacSecret?: string;
  },
): Promise<void> {
  if (!ntfyServer.startsWith("https://")) {
    console.warn(`[ntfy] Rejected non-HTTPS ntfy server URL`);
    return;
  }
  if (!payload.bridgeCallbackBase.startsWith("https://")) {
    console.warn(
      `[ntfy] bridgeCallbackBase must be https:// for action buttons; skipping ntfy publish`,
    );
    return;
  }
  let hostname: string;
  try {
    hostname = new URL(ntfyServer).hostname;
  } catch {
    console.warn(`[ntfy] Malformed ntfy server URL — skipping`);
    return;
  }
  if (hostname === "localhost") {
    console.warn(`[ntfy] Blocked loopback ntfy server hostname`);
    return;
  }
  if (await hostResolvesToBlockedIp(hostname, "ntfy")) return;

  const callbackBase = payload.bridgeCallbackBase.replace(/\/+$/, "");
  const { createHmac } = await import("node:crypto");
  let approveUrl: string;
  let rejectUrl: string;
  let actionHeaders: Record<string, string>;

  if (payload.hmacSecret) {
    // M23: sign callback URLs with HMAC-SHA256 so the approval token never
    // appears in the ntfy notification body (visible to all topic subscribers).
    // sig = HMAC(secret, "approve:callId") / HMAC(secret, "reject:callId").
    const approveSig = createHmac("sha256", payload.hmacSecret)
      .update(`approve:${payload.callId}`)
      .digest("hex");
    const rejectSig = createHmac("sha256", payload.hmacSecret)
      .update(`reject:${payload.callId}`)
      .digest("hex");
    approveUrl = `${callbackBase}/approve/${payload.callId}?sig=${approveSig}`;
    rejectUrl = `${callbackBase}/reject/${payload.callId}?sig=${rejectSig}`;
    actionHeaders = { "Content-Type": "application/json" };
  } else {
    // Legacy path: embed token in action headers. Still better than a URL
    // query param (not in access logs) but visible to all topic subscribers.
    approveUrl = `${callbackBase}/approve/${payload.callId}`;
    rejectUrl = `${callbackBase}/reject/${payload.callId}`;
    actionHeaders = {
      "Content-Type": "application/json",
      "x-approval-token": payload.approvalToken,
    };
  }
  const body = JSON.stringify({
    topic: payload.topic,
    title: `Approve ${payload.toolName}? (${payload.tier})`,
    message: payload.summary ?? `Pending tool call ${payload.callId}`,
    tags: ["lock", "warning"],
    priority: payload.tier === "high" ? 5 : 4,
    actions: [
      {
        action: "http",
        label: "Approve",
        method: "POST",
        url: approveUrl,
        headers: actionHeaders,
        clear: true,
      },
      {
        action: "http",
        label: "Reject",
        method: "POST",
        url: rejectUrl,
        headers: actionHeaders,
        clear: true,
      },
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${ntfyServer.replace(/\/+$/, "")}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[ntfy] Non-2xx from ntfy server: ${res.status} ${res.statusText}`,
      );
    }
  } catch (err) {
    console.warn(
      `[ntfy] Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publish a confirmation to ntfy after an approval is decided. Gives the
 * lock-screen tap visible feedback the iOS ntfy app does not produce on its
 * own. Best-effort, fire-and-forget — never blocks decision lifecycle.
 */
async function dispatchNtfyConfirmation(
  ntfyServer: string,
  payload: { topic: string; toolName: string; outcome: string },
): Promise<void> {
  if (!ntfyServer.startsWith("https://")) return;
  let hostname: string;
  try {
    hostname = new URL(ntfyServer).hostname;
  } catch {
    return;
  }
  if (hostname === "localhost") return;
  if (await hostResolvesToBlockedIp(hostname)) return;
  const approved = payload.outcome === "approved";
  const body = JSON.stringify({
    topic: payload.topic,
    title: approved
      ? `✓ Approved ${payload.toolName}`
      : `✗ Rejected ${payload.toolName}`,
    message: approved
      ? "Tool call unblocked. Decision recorded."
      : "Tool call rejected. Decision recorded.",
    tags: [approved ? "white_check_mark" : "x"],
    priority: 2,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(`${ntfyServer.replace(/\/+$/, "")}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timer);
  }
}

/** Notification-relevant subset of ApprovalDeps — the fields every approval
 *  entry point (HTTP /approvals route, CLI PreToolUse gate) needs to fan out
 *  webhook/push/ntfy dispatch identically. */
export interface ApprovalNotifyDeps {
  queue: ApprovalQueue;
  webhookUrl?: string;
  pushServiceUrl?: string;
  pushServiceToken?: string;
  pushServiceBaseUrl?: string;
  pushServiceAllowPrivate?: boolean;
  ntfyTopic?: string;
  ntfyServer?: string;
  ntfyHmacSecret?: string;
}

/**
 * Queue an approval and fan out every configured notification channel
 * (webhook, Web Push, ntfy) identically. Extracted so both the HTTP
 * `/approvals` route (`handleApprovalRequest`) and the CLI PreToolUse gate
 * (`transport.setApprovalGate` in bridge.ts) get the same phone-path
 * notifications — before this extraction, CLI-originated approvals (the
 * common case: `gitCommit`, `runInTerminal`, etc. from `claude` itself)
 * silently enqueued with NO notification of any kind, since the CLI gate
 * called `queue.request()` directly and never touched the dispatch* helpers
 * below.
 */
export function enqueueApprovalWithDispatch(
  deps: ApprovalNotifyDeps,
  request: {
    toolName: string;
    params: Record<string, unknown>;
    tier: RiskTier;
    riskSignals: RiskSignal[];
    summary?: string;
    sessionId?: string;
    personalSignals?: ReturnType<typeof computePersonalSignals>;
  },
): {
  callId: string;
  promise: Promise<ApprovalDecision>;
} {
  const { toolName, params, tier, riskSignals, summary, sessionId } = request;
  const now = Date.now();
  const { callId, approvalToken, promise } = deps.queue.request(
    {
      toolName,
      params,
      tier,
      summary,
      sessionId,
      riskSignals,
      ...(request.personalSignals !== undefined && {
        personalSignals: request.personalSignals,
      }),
    },
    { withToken: !!deps.pushServiceUrl || !!deps.ntfyTopic },
  );
  recordApprovalPrompted();

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

  if (deps.pushServiceUrl && deps.pushServiceToken && approvalToken) {
    dispatchPushNotification(
      deps.pushServiceUrl,
      deps.pushServiceToken,
      {
        toolName,
        tier,
        callId,
        requestedAt: now,
        expiresAt: now + 5 * 60_000,
        summary,
        riskSignals,
        approvalToken,
        bridgeCallbackBase: deps.pushServiceBaseUrl ?? "",
      },
      deps.pushServiceAllowPrivate ?? false,
    ).catch(() => {});
  }

  if (deps.ntfyTopic && approvalToken && deps.pushServiceBaseUrl) {
    dispatchNtfyApproval(deps.ntfyServer ?? "https://ntfy.sh", {
      topic: deps.ntfyTopic,
      toolName,
      tier,
      callId,
      summary,
      approvalToken,
      bridgeCallbackBase: deps.pushServiceBaseUrl,
      hmacSecret: deps.ntfyHmacSecret,
    }).catch(() => {});
  }

  return { callId, promise };
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

  if (!toolName) {
    return { status: 400, body: { error: "toolName required" } };
  }

  // Capture the inputs the policy saw on EVERY decision path, not just the
  // queue-awaiting path. A future "decision replay debugger" needs to be able
  // to fold a new policy over historical inputs — that requires `params`,
  // `tier`, and `riskSignals` on every approval_decision row, not just rows
  // that hit a human dashboard.
  //
  // Cost: classifyTool is a table lookup; computeRiskSignals is regex + one
  // path.resolve. Both cheap. captureForRunlog redacts known secret keys and
  // caps the JSON envelope at 8 KB so a giant `params.command` won't bloat
  // the lifecycle log.
  //
  // Older rows (pre-this-PR) lack these fields. Readers must treat them as
  // optional. There is no backfill — the inputs simply weren't captured.
  const tier = classifyTool(toolName);
  const riskSignals = computeRiskSignals(toolName, params, deps.workspace);
  const capturedParams = captureForRunlog(params);

  const emit = (
    decision: string,
    reason: string,
    extras?: {
      callId?: string;
      // Epoch-ms the approval was PROMPTED (queued). Present only on the
      // human-decision path (after a queue wait); absent on instant-policy
      // emits (gate_off / cc_allow_rule / …) which have no deliberation
      // latency. The considered-approval KPI derives latency-to-decision as
      // `event.timestamp − requestedAt`; without it, latency is unrecoverable
      // retroactively (the queue entry is gone by decision time).
      requestedAt?: number;
    },
  ) =>
    deps.onDecision?.("approval_decision", {
      toolName,
      specifier,
      decision,
      reason,
      permissionMode,
      sessionId,
      tier,
      // Workspace path captured so heuristic 9 (workspace mismatch) can
      // tell "this tool was approved in workspace A; the call coming in
      // from workspace B is novel here." Older rows lack this field —
      // h9 treats absent workspace as "no baseline", same as new tools.
      workspace: deps.workspace,
      ...(capturedParams !== undefined && { params: capturedParams }),
      ...(riskSignals.length > 0 && { riskSignals }),
      ...(summary !== undefined && { summary }),
      ...(extras?.callId && { callId: extras.callId }),
      ...(extras?.requestedAt !== undefined && {
        requestedAt: extras.requestedAt,
      }),
    });

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

  // Fall through to dashboard approval. tier + riskSignals were already
  // computed at the top of this function so emit() carries them on every
  // decision path — see the comment block above the emit definition.

  // Respect approvalGate setting — "off" bypasses, "high" only queues high-tier tools
  const gate = deps.approvalGate ?? "off";
  if (gate === "off") {
    emit("allow", "gate_off");
    return { status: 200, body: { decision: "allow", reason: "gate_off" } };
  }
  // A high-severity content signal (rm -rf, sudo, terraform destroy, path
  // escape, …) forces the queue even for a sub-high tier, mirroring the
  // in-process gate so CC-native calls aren't gated content-blind. Additive:
  // only ever removes a bypass, never adds one, and runs AFTER the CC
  // deny/ask/dontAsk/plan precedence so a signal can't downgrade a deny. (P0-2)
  const hasHighSeverity = riskSignals.some((s) => s.severity === "high");
  if (gate === "high" && tier !== "high" && !hasHighSeverity) {
    emit("allow", "gate_below_threshold");
    return {
      status: 200,
      body: { decision: "allow", reason: "gate_below_threshold" },
    };
  }

  // Personal signals — passive risk personalization. Only computed when
  // an ActivityLog is wired up; tests / minimal harnesses leave it
  // undefined. See src/approvalSignals.ts for the catalog.
  //
  // Eagerly imported at the top of this file (was lazy via dynamic
  // import in #137). The lazy form raced under full-suite CPU
  // contention: the dynamic import could resolve after the
  // approvalHttp.test.ts "propagates personalSignals onto queued
  // PendingApproval" test's 10ms wait, leaving queue.list() empty when
  // the assertion fired. The lazy-cost benefit (~150 LOC of dead code
  // for users without an ActivityLog) was negligible — the module is
  // already imported by the activity log path on first approval — so
  // the eager import is the right tradeoff.
  const personalSignals = deps.activityLog
    ? computePersonalSignals({
        toolName,
        activityLog: deps.activityLog,
        currentTier: tier,
        currentWorkspace: deps.workspace,
        currentParams: params,
        recipeRunLog: deps.recipeRunLog,
        enableTimeOfDayAnomaly: deps.enableTimeOfDayAnomaly,
      })
    : undefined;

  const now = Date.now();
  const { callId, promise } = enqueueApprovalWithDispatch(deps, {
    toolName,
    params,
    tier,
    riskSignals,
    summary,
    sessionId,
    personalSignals,
  });

  const outcome = await promise;
  if (outcome !== "expired") {
    recordApprovalCompleted();
  }
  emit(outcome === "approved" ? "allow" : "deny", outcome, {
    callId,
    requestedAt: now,
  });

  // Publish a confirmation back to the same ntfy topic so the lock-screen
  // tap has visible feedback. The iOS ntfy app gives no UI signal when an
  // http action fires successfully; without this follow-up the user can't
  // tell whether their tap landed. Skip on "expired" — the approval ran
  // out before any human input arrived, so there's nothing to confirm.
  if (deps.ntfyTopic && deps.pushServiceBaseUrl && outcome !== "expired") {
    dispatchNtfyConfirmation(deps.ntfyServer ?? "https://ntfy.sh", {
      topic: deps.ntfyTopic,
      toolName,
      outcome,
    }).catch(() => {});
  }
  return {
    status: 200,
    body: {
      decision: outcome === "approved" ? "allow" : "deny",
      reason: outcome,
      callId,
    },
  };
}
