import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer as WsServer } from "ws";
import {
  computeSummary as computeActivationSummary,
  loadMetrics as loadActivationMetrics,
} from "./activationMetrics.js";
import { handleApprovalsStream, routeApprovalRequest } from "./approvalHttp.js";
import { getApprovalQueue } from "./approvalQueue.js";
import { saveBridgeConfigDriver } from "./config.js";
import { timingSafeStringEqual } from "./crypto.js";
import { renderDashboardHtml } from "./dashboard.js";
import type { Logger } from "./logger.js";
import type { OAuthServer } from "./oauth.js";
import {
  loadConfig as loadPatchworkConfig,
  type PatchworkConfig,
  defaultConfigPath as patchworkConfigPath,
  saveConfig as savePatchworkConfig,
} from "./patchworkConfig.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  PACKAGE_LICENSE,
  PACKAGE_VERSION,
} from "./version.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type { ActivityListener } from "./activityTypes.js";
import type { RecipeDraft } from "./recipesHttp.js";

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
  missedPongs: number;
  lastPongTime: number;
  lastPingTime: number;
  disconnectReason?: string;
  /** Session ID sent by the client via X-Claude-Code-Session-Id for grace-period resumption. */
  clientSessionId?: string;
}

function enableTcpKeepalive(ws: WebSocket): void {
  const rawSocket = (ws as unknown as { _socket?: import("net").Socket })
    ._socket;
  if (rawSocket?.setKeepAlive) {
    rawSocket.setKeepAlive(true, 60_000); // 60s TCP keepalive as defense-in-depth
  }
}

interface ServerEvents {
  connection: [ws: WebSocket];
  extension: [ws: WebSocket];
}

/**
 * Return the CORS origin to reflect, or null if the origin is untrusted.
 * Loopback origins are always allowed. Additional origins can be passed via
 * --cors-origin (e.g. https://claude.ai for remote deployments).
 */
export function corsOrigin(
  requestOrigin: string | undefined,
  extraOrigins: string[] = [],
): string | null {
  if (!requestOrigin) return null;
  if (extraOrigins.includes(requestOrigin)) return requestOrigin;
  try {
    const { hostname, protocol } = new URL(requestOrigin);
    if (
      protocol === "http:" &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]")
    ) {
      return requestOrigin;
    }
  } catch {
    // malformed origin — deny
  }
  return null;
}

// Re-export canonical constant-time comparison for use in this module.
// Implementation lives in src/crypto.ts — see there for security notes.
const timingSafeTokenCompare = timingSafeStringEqual;

function setupPongHandler(ws: AliveWebSocket): void {
  ws.on("pong", (_data: Buffer) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    // Always record the current time — do not trust the client-echoed payload
    // timestamp, which can be spoofed to make lastPongTime appear stale.
    ws.lastPongTime = Date.now();
  });
}

// 500ms minimum between connections per client type.
// Tradeoff: multi-agent scenarios where two agents connect simultaneously may
// hit this limit; they will retry and connect successfully on the next attempt.
// Raised from 50ms to reduce connection-storm DoS surface in public deployments.
const MIN_CONNECTION_INTERVAL_MS = 500;

export interface SessionSummary {
  id: string;
  connectedAt: string; // ISO string
  openedFileCount: number;
  pendingApprovals: number;
  firstTool?: string;
  remoteAddr?: string;
}

export class Server extends EventEmitter<ServerEvents> {
  private httpServer: http.Server;
  private wss: WsServer;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastClaudeConnectionTime = 0;
  private lastExtensionConnectionTime = 0;
  private startTime = Date.now();
  /** OAuth 2.0 Authorization Server — set via setOAuthServer() when running in remote mode */
  private oauthServer: OAuthServer | null = null;
  private oauthIssuerUrl: string | null = null;
  private sseSubscriberCount = 0;
  private static readonly MAX_SSE_SUBSCRIBERS = 20;

  /** Set by bridge to provide health data */
  public healthDataFn: (() => Record<string, unknown>) | null = null;
  /** Set by bridge to provide Prometheus metrics */
  public metricsFn: (() => string) | null = null;
  /** Set by bridge to provide rich status data */
  public statusFn: (() => Record<string, unknown>) | null = null;
  /** Set by bridge to provide performance report data for /dashboard/data */
  public perfDataFn: (() => Record<string, unknown>) | null = null;
  /** Set by bridge to provide readiness data (MCP handshake complete, tool count, extension) */
  public readyFn:
    | (() => { ready: boolean; toolCount: number; extensionConnected: boolean })
    | null = null;
  /** Set by bridge to provide task list data (sanitized — no raw prompts) */
  public tasksFn: (() => { tasks: Record<string, unknown>[] }) | null = null;
  /** Set by bridge to cancel a running/pending task by id. Returns true if found. */
  public cancelTaskFn: ((id: string) => boolean) | null = null;
  /** Patchwork: set by bridge to list installed recipes for the dashboard. */
  public recipesFn: (() => Record<string, unknown>) | null = null;
  /** Patchwork: set by bridge to load raw recipe source content by name. */
  public loadRecipeContentFn:
    | ((name: string) => { content: string; path: string } | null)
    | null = null;
  /** Patchwork: set by bridge to save raw recipe source content by name. */
  public saveRecipeContentFn:
    | ((
        name: string,
        content: string,
      ) => {
        ok: boolean;
        path?: string;
        error?: string;
        warnings?: string[];
      })
    | null = null;
  /** Patchwork: set by bridge to delete a recipe by name. */
  public deleteRecipeContentFn:
    | ((name: string) => { ok: boolean; path?: string; error?: string })
    | null = null;
  /** Patchwork: set by bridge to lint raw recipe content without saving. */
  public lintRecipeContentFn:
    | ((content: string) => {
        ok: boolean;
        errors: string[];
        warnings: string[];
      })
    | null = null;
  /** Patchwork: set by bridge to save a new recipe draft to disk. */
  public saveRecipeFn:
    | ((draft: RecipeDraft) => { ok: boolean; path?: string; error?: string })
    | null = null;
  /** Patchwork: set by bridge to query the recipe run audit log. */
  public runsFn:
    | ((q: {
        limit?: number;
        trigger?: string;
        status?: string;
        recipe?: string;
        after?: number;
      }) => Record<string, unknown>[])
    | null = null;
  /** Patchwork: set by bridge to fetch a single run by seq for the detail page. */
  public runDetailFn: ((seq: number) => Record<string, unknown> | null) | null =
    null;
  /** Patchwork: set by bridge to generate a dry-run plan for a recipe by name. */
  public runPlanFn:
    | ((recipeName: string) => Promise<Record<string, unknown>>)
    | null = null;
  /** Patchwork (VD-4): mocked replay of an existing run. Returns the new
   *  run's seq plus any unmocked steps the caller may want to surface. */
  public runReplayFn:
    | ((seq: number) => Promise<{
        ok: boolean;
        newSeq?: number;
        unmockedSteps?: string[];
        error?: string;
      }>)
    | null = null;
  /** Patchwork: set by bridge to launch a named recipe via the orchestrator. */
  public runRecipeFn:
    | ((
        name: string,
        vars?: Record<string, string>,
      ) => Promise<{ ok: boolean; taskId?: string; error?: string }>)
    | null = null;
  /** Patchwork: admin-controlled managed settings path (highest rule precedence). */
  public managedSettingsPath: string | undefined = undefined;
  /** Effective bridge config path to update when dashboard saves driver changes. */
  public bridgeConfigPath: string | undefined = undefined;
  /** Patchwork: live approval gate level — mutated by POST /settings, read by bridge per-session setup. */
  public approvalGate: "off" | "high" | "all" = "off";
  /** Patchwork: outbound webhook URL for approval notifications (from dashboard.webhookUrl in config). */
  public approvalWebhookUrl: string | undefined = undefined;
  /** Patchwork: push relay service URL — when set, per-callId approval tokens are generated. */
  public pushServiceUrl: string | undefined = undefined;
  /** Patchwork: bearer token for the push relay service. */
  public pushServiceToken: string | undefined = undefined;
  /** Patchwork: public base URL of this bridge, embedded in push payloads as callback base. */
  public pushServiceBaseUrl: string | undefined = undefined;
  /** Patchwork: approval decision audit callback wired to activityLog.recordEvent. */
  public onApprovalDecision:
    | ((event: string, meta: Record<string, unknown>) => void)
    | undefined = undefined;
  /** Patchwork: set by bridge to match + fire webhook-triggered recipes. */
  public webhookFn:
    | ((
        path: string,
        payload: unknown,
      ) => Promise<{
        ok: boolean;
        taskId?: string;
        name?: string;
        error?: string;
      }>)
    | null = null;
  /** Set by bridge to handle MCP Streamable HTTP sessions (POST/GET/DELETE /mcp) */
  public httpMcpHandler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
    | null = null;
  /** Set by bridge to subscribe a caller to real-time activity events. Returns unsubscribe fn. */
  public streamFn: ((listener: ActivityListener) => () => void) | null = null;
  /** Set to true via --no-dashboard to disable the /dashboard route. */
  public noDashboard = false;
  /** Set by bridge to provide analytics report data (top tools, hooks, tasks) */
  public analyticsFn:
    | ((windowHours?: number) => Promise<Record<string, unknown>>)
    | null = null;
  /** Set by bridge to answer GET /activity — history of recent tool calls + lifecycle events. */
  public activityFn: ((last: number) => Record<string, unknown>[]) | null =
    null;
  /** Set by bridge to answer GET /approvals/:callId — decision record + nearby session activity. */
  public approvalDetailFn:
    | ((callId: string) => {
        pending: Record<string, unknown> | null;
        decision: Record<string, unknown> | null;
        nearby: Record<string, unknown>[];
      })
    | null = null;
  /** Set by bridge to answer GET /traces via ctxQueryTraces over persistent logs. */
  public tracesFn:
    | ((query: {
        traceType?: string;
        key?: string;
        q?: string;
        tag?: string;
        since?: number;
        limit?: number;
      }) => Promise<Record<string, unknown>>)
    | null = null;
  /** Set by bridge to handle CC hook notify events via POST /notify */
  public notifyFn:
    | ((
        event: string,
        args: Record<string, string>,
      ) => { ok: boolean; error?: string })
    | null = null;
  /** Patchwork: set by bridge to list active agent sessions for the dashboard. */
  public sessionsFn: (() => SessionSummary[]) | null = null;
  private _templatesCache: unknown = null;
  private _templatesCacheTs = 0;
  /** Patchwork: set by bridge to answer GET /sessions/:id with per-session event stream + approvals. */
  public sessionDetailFn:
    | ((id: string) => {
        summary: SessionSummary | null;
        lifecycle: Record<string, unknown>[];
        tools: Record<string, unknown>[];
        decisions: Record<string, unknown>[];
        approvals: Record<string, unknown>[];
      })
    | null = null;
  /** Set by bridge to handle POST /launch-quick-task — invokes launchQuickTask tool in-process. */
  public launchQuickTaskFn:
    | ((
        presetId: string,
        source: string,
      ) => Promise<{
        ok: boolean;
        result?: unknown;
        error?: string;
        code?: string;
      }>)
    | null = null;

  public setRecipeEnabledFn:
    | ((name: string, enabled: boolean) => { ok: boolean; error?: string })
    | null = null;

  /**
   * Attach an OAuth 2.0 Authorization Server.
   * When set, the bridge exposes:
   *   GET  /.well-known/oauth-authorization-server
   *   GET  /oauth/authorize
   *   POST /oauth/token
   *   POST /oauth/revoke
   * Bearer tokens issued via the OAuth flow are accepted in addition to the
   * static bridge token, enabling claude.ai's authenticated MCP server flow.
   */
  setOAuthServer(oauth: OAuthServer, issuerUrl: string): void {
    this.oauthServer = oauth;
    this.oauthIssuerUrl = issuerUrl;
  }

  /** Hosts accepted in the WebSocket upgrade Host header (DNS-rebinding guard). */
  private readonly allowedHosts: Set<string>;

  constructor(
    private authToken: string,
    private logger: Logger,
    private extraCorsOrigins: string[] = [],
    private pingIntervalMs = 30_000,
  ) {
    super();
    // Defense-in-depth: ensure token is non-empty so timingSafeTokenCompare
    // cannot accept a blank Authorization header against an empty token.
    if (authToken.length === 0) {
      throw new Error("authToken must not be empty");
    }

    // Build the WS Host allowlist: loopback always allowed, plus hostnames
    // extracted from --cors-origin values so remote reverse-proxy deployments
    // (where the proxy forwards the real Host header) are not rejected.
    this.allowedHosts = new Set(LOOPBACK_HOSTS);
    for (const origin of extraCorsOrigins) {
      try {
        this.allowedHosts.add(new URL(origin).hostname);
      } catch {
        // ignore malformed origins — already validated at startup
      }
    }
    if (authToken.length < 32) {
      logger.warn(
        `authToken is only ${authToken.length} chars — production tokens should be ≥ 32 chars (crypto.randomBytes(32).toString('hex'))`,
      );
    }
    this.httpServer = http.createServer(async (req, res) => {
      // Security headers on all responses
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");

      // CORS — set on every response so browsers can read 401s and initiate OAuth
      const allowedOrigin = corsOrigin(
        req.headers.origin,
        this.extraCorsOrigins,
      );
      if (allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, Mcp-Session-Id",
        );
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      }

      const parsedUrl = new URL(req.url ?? "/", "http://localhost");

      // ── OAuth 2.0 endpoints (unauthenticated — handled before bearer check) ──

      // RFC 8414 discovery document
      if (
        parsedUrl.pathname === "/.well-known/oauth-authorization-server" &&
        req.method === "GET"
      ) {
        if (this.oauthServer) {
          this.oauthServer.handleDiscovery(res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // RFC 9396 Protected Resource Metadata — Claude.ai probes this to discover
      // which authorization server protects this resource. Both the bare and
      // resource-path variants are handled.
      if (
        req.method === "GET" &&
        (parsedUrl.pathname === "/.well-known/oauth-protected-resource" ||
          parsedUrl.pathname.startsWith(
            "/.well-known/oauth-protected-resource/",
          ))
      ) {
        if (this.oauthServer && this.oauthIssuerUrl) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(
            JSON.stringify({
              resource: this.oauthIssuerUrl,
              authorization_servers: [this.oauthIssuerUrl],
            }),
          );
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Authorization endpoint
      if (
        parsedUrl.pathname === "/oauth/authorize" &&
        (req.method === "GET" || req.method === "POST")
      ) {
        if (this.oauthServer) {
          this.oauthServer.handleAuthorize(req, res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Dynamic Client Registration endpoint (RFC 7591)
      if (parsedUrl.pathname === "/oauth/register") {
        if (this.oauthServer) {
          this.oauthServer.handleRegister(req, res).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Token endpoint
      if (parsedUrl.pathname === "/oauth/token" && req.method === "POST") {
        if (this.oauthServer) {
          this.oauthServer.handleToken(req, res).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Revocation endpoint (RFC 7009)
      if (parsedUrl.pathname === "/oauth/revoke" && req.method === "POST") {
        if (this.oauthServer) {
          this.oauthServer.handleRevoke(req, res).catch(() => {
            // RFC 7009: always 200
            if (!res.headersSent) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end("{}");
            }
          });
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
        return;
      }

      // ── MCP server-card (public) ──────────────────────────────────────────

      if (
        req.url === "/.well-known/mcp/server-card.json" ||
        req.url === "/.well-known/mcp"
      ) {
        const card = {
          name: "claude-ide-bridge",
          version: BRIDGE_PROTOCOL_VERSION,
          description:
            "MCP bridge providing full IDE integration for Claude Code — LSP, diagnostics, file operations, terminal, debug adapters, and AI task orchestration",
          homepage: "https://github.com/Oolab-labs/claude-ide-bridge",
          transport: ["websocket", "stdio", "streamable-http"],
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            elicitation: true,
          },
          author: "Oolab Labs",
          license: PACKAGE_LICENSE,
          repository: "https://github.com/Oolab-labs/claude-ide-bridge",
        };
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(card, null, 2));
        return;
      }

      // CORS preflight for /mcp — browsers (and Claude Desktop's web renderer) send
      // OPTIONS before POST. Respond without requiring auth so the preflight succeeds.
      if (req.method === "OPTIONS" && parsedUrl.pathname === "/mcp") {
        const origin = corsOrigin(req.headers.origin, this.extraCorsOrigins);
        if (origin) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, DELETE, OPTIONS",
          );
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, Mcp-Session-Id",
          );
          res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // Unauthenticated liveness probe — safe to expose; contains no sensitive data.
      // NOTE: /dashboard and /dashboard/data are unauthenticated. They expose only
      // version, uptime, session count, and extension state — no workspace paths
      // or tool outputs. For public VPS deployments (--bind 0.0.0.0), restrict
      // at nginx/firewall or disable with --no-dashboard.
      if (
        (req.url === "/dashboard" || req.url === "/dashboard/") &&
        req.method === "GET" &&
        !this.noDashboard
      ) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboardHtml(PACKAGE_VERSION));
        return;
      }
      if (
        req.url === "/dashboard/data" &&
        req.method === "GET" &&
        !this.noDashboard
      ) {
        const health = this.healthDataFn?.() ?? {};
        const status = this.statusFn?.() ?? {};
        const data = {
          version: PACKAGE_VERSION,
          uptimeMs: Date.now() - this.startTime,
          sessions: this.wss.clients.size,
          extensionConnected:
            (health as { extensionConnected?: boolean }).extensionConnected ??
            false,
          extensionVersion: (health as { extensionVersion?: string })
            .extensionVersion,
          events: (status as { events?: unknown[] }).events ?? [],
          perf: this.perfDataFn?.() ?? null,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.url === "/ping" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, v: PACKAGE_VERSION }));
        return;
      }

      // ── Connector OAuth callbacks (unauthenticated — browser redirect from vendor) ──
      if (
        parsedUrl.pathname === "/connections/github/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleGithubCallback } = await import(
            "./connectors/github.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleGithubCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/linear/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleLinearCallback } = await import(
            "./connectors/linear.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleLinearCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/sentry/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleSentryCallback } = await import(
            "./connectors/sentry.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleSentryCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-calendar/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleCalendarCallback } = await import(
            "./connectors/googleCalendar.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleCalendarCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      if (
        parsedUrl.pathname === "/connections/google-drive/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleDriveCallback } = await import(
            "./connectors/googleDrive.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleDriveCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      if (
        parsedUrl.pathname === "/connections/slack/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleSlackCallback } = await import("./connectors/slack.js");
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleSlackCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      if (
        parsedUrl.pathname === "/connections/gmail/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleGmailCallback } = await import("./connectors/gmail.js");
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleGmailCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "text/html",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── /schemas/* — unauthenticated registry-derived JSON Schemas ────────
      // Serves recipe.v1.json, dry-run-plan.v1.json, tools/<ns>.json so YAML-LSP
      // editors can resolve `$schema:` headers against a running bridge. No
      // secrets — schemas are generated from the tool registry.
      if (parsedUrl.pathname?.startsWith("/schemas/") && req.method === "GET") {
        try {
          await import("./recipes/tools/index.js");
          const { generateSchemaSet } = await import(
            "./recipes/schemaGenerator.js"
          );
          const schemas = generateSchemaSet();
          const rest = parsedUrl.pathname.slice("/schemas/".length);
          let body: unknown;

          if (rest === "recipe.v1.json") {
            body = schemas.recipe;
          } else if (rest === "dry-run-plan.v1.json") {
            body = schemas.dryRunPlan;
          } else if (rest.startsWith("tools/") && rest.endsWith(".json")) {
            const ns = rest.slice("tools/".length, -".json".length);
            body = schemas.namespaces[ns];
          } else if (rest === "" || rest === "index.json") {
            body = {
              recipe: "/schemas/recipe.v1.json",
              dryRunPlan: "/schemas/dry-run-plan.v1.json",
              tools: Object.keys(schemas.namespaces).map(
                (ns) => `/schemas/tools/${ns}.json`,
              ),
            };
          }

          if (body === undefined) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `schema not found: ${rest}` }));
            return;
          }

          res.writeHead(200, {
            "Content-Type": "application/schema+json",
            "Cache-Control": "public, max-age=60",
          });
          res.end(JSON.stringify(body, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      // ── Bearer token authentication ───────────────────────────────────────
      // All other HTTP endpoints require a valid Bearer token.
      // Accepts either:
      //   (a) the bridge's static token (--fixed-token / generated on start), or
      //   (b) an OAuth 2.0 access token issued via /oauth/token (when oauthServer is set)
      const authHeader = req.headers.authorization ?? "";
      const bearerFromHeader = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";
      // ?token= query param support was removed — tokens in URLs appear in
      // HTTP access logs, proxy logs, and Referrer headers. Use the
      // Authorization: Bearer header exclusively.
      const bearer = bearerFromHeader;

      const isStaticToken = timingSafeTokenCompare(bearer, this.authToken);
      const oauthResolved =
        !isStaticToken && this.oauthServer
          ? this.oauthServer.resolveBearerToken(bearer)
          : null;
      // Phone-path: approve/reject with x-approval-token bypass bearer check.
      // The token itself is validated inside routeApprovalRequest via queue.validateToken.
      const isPhoneApprovalPath =
        req.method === "POST" &&
        /^\/(approve|reject)\/[A-Za-z0-9-]+$/.test(parsedUrl.pathname) &&
        !!req.headers["x-approval-token"];
      // oauthResolved is the bridge token if the OAuth token is valid; null otherwise
      if (!isStaticToken && !oauthResolved && !isPhoneApprovalPath) {
        // RFC 6750: only include error= when a token was actually presented but invalid
        const tokenPresented = bearer.length > 0;
        const wwwAuth =
          this.oauthServer && this.oauthIssuerUrl
            ? `Bearer realm="claude-ide-bridge", resource_metadata="${this.oauthIssuerUrl}/.well-known/oauth-protected-resource"${tokenPresented ? `, error="invalid_token"` : ""}`
            : `Bearer realm="claude-ide-bridge"${tokenPresented ? `, error="invalid_token"` : ""}`;
        res.writeHead(401, {
          "Content-Type": "text/plain",
          "WWW-Authenticate": wwwAuth,
        });
        res.end("Unauthorized");
        return;
      }

      if (parsedUrl.pathname === "/metrics" && req.method === "GET") {
        try {
          const body = this.metricsFn?.() ?? "";
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        try {
          const data = {
            status: "ok",
            uptimeMs: Date.now() - this.startTime,
            connections: this.wss.clients.size,
            ...(this.healthDataFn?.() ?? {}),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/activity" && req.method === "GET") {
        try {
          const lastStr = parsedUrl.searchParams.get("last");
          const last =
            lastStr !== null && /^\d+$/.test(lastStr)
              ? Math.min(Number(lastStr), 500)
              : 100;
          const data = this.activityFn?.(last) ?? [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ events: data, count: data.length }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/traces" && req.method === "GET") {
        try {
          const q = parsedUrl.searchParams;
          const sinceStr = q.get("since");
          const limitStr = q.get("limit");
          const data = this.tracesFn
            ? await this.tracesFn({
                traceType: q.get("traceType") ?? undefined,
                key: q.get("key") ?? undefined,
                q: q.get("q") ?? undefined,
                tag: q.get("tag") ?? undefined,
                since:
                  sinceStr !== null && /^\d+$/.test(sinceStr)
                    ? Number(sinceStr)
                    : undefined,
                limit:
                  limitStr !== null && /^\d+$/.test(limitStr)
                    ? Number(limitStr)
                    : undefined,
              })
            : {
                traces: [],
                count: 0,
                sources: {
                  approval: false,
                  enrichment: false,
                  recipe_run: false,
                },
                hint: "Trace sources not wired yet.",
              };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/analytics" && req.method === "GET") {
        try {
          const wh = parsedUrl.searchParams.get("windowHours");
          const windowHours =
            wh !== null && /^\d+$/.test(wh) ? Number(wh) : undefined;
          const data = await (this.analyticsFn
            ? this.analyticsFn(windowHours)
            : Promise.resolve({
                generatedAt: new Date().toISOString(),
                windowHours: windowHours ?? 24,
                topTools: [],
                hooksLast24h: 0,
                recentAutomationTasks: [],
                hint: "Analytics not available — bridge driver not configured.",
              }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/status" && req.method === "GET") {
        try {
          const data = {
            uptimeMs: Date.now() - this.startTime,
            ...(this.statusFn?.() ?? {}),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/ready" && req.method === "GET") {
        try {
          const info = this.readyFn?.() ?? {
            ready: false,
            toolCount: 0,
            extensionConnected: false,
          };
          if (info.ready) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ready: true,
                toolCount: info.toolCount,
                extensionConnected: info.extensionConnected,
              }),
            );
          } else {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ready: false,
                reason: "awaiting MCP handshake",
              }),
            );
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/stream" && req.method === "GET") {
        if (this.sseSubscriberCount >= Server.MAX_SSE_SUBSCRIBERS) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Too many SSE subscribers (max 20)" }),
          );
          return;
        }
        this.sseSubscriberCount++;
        // Disable socket timeout — SSE connections are long-lived by design
        res.socket?.setTimeout(0);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();

        const unsub =
          this.streamFn?.((kind, entry) => {
            try {
              res.write(`data: ${JSON.stringify({ kind, ...entry })}\n\n`);
            } catch {
              // Client disconnected — unsubscribe on next tick
              unsub?.();
            }
          }) ?? (() => {});

        // Keep-alive comment ping every 15s so proxies don't close idle connections
        const ping = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            clearInterval(ping);
            unsub();
          }
        }, 15_000);
        ping.unref();

        req.on("close", () => {
          this.sseSubscriberCount--;
          clearInterval(ping);
          unsub();
        });
        return;
      }
      if (req.url === "/tasks" && req.method === "GET") {
        try {
          const data = this.tasksFn?.() ?? { tasks: [] };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      const cancelMatch = parsedUrl.pathname?.match(
        /^\/tasks\/([^/]+)\/cancel$/,
      );
      if (cancelMatch && req.method === "POST") {
        const taskId = cancelMatch[1] as string;
        try {
          const found = this.cancelTaskFn?.(taskId) ?? false;
          if (!found) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "task not found or already terminal" }),
            );
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname?.startsWith("/hooks/") && req.method === "POST") {
        const hookPath = parsedUrl.pathname.substring("/hooks".length);
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            let payload: unknown;
            if (chunks.length > 0) {
              const body = Buffer.concat(chunks).toString("utf-8");
              if (body.trim()) {
                try {
                  payload = JSON.parse(body);
                } catch {
                  payload = body;
                }
              }
            }
            if (!this.webhookFn) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error:
                    "Webhooks unavailable — start bridge with --claude-driver subprocess",
                }),
              );
              return;
            }
            const result = await this.webhookFn(hookPath, payload);
            const status = result.ok
              ? 200
              : result.error === "not_found"
                ? 404
                : 400;
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          })();
        });
        return;
      }
      // ── Gmail / Connections endpoints ───────────────────────────────────────
      if (parsedUrl.pathname === "/connections" && req.method === "GET") {
        void (async () => {
          const { handleConnectionsList } = await import(
            "./connectors/gmail.js"
          );
          const result = await handleConnectionsList();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/gmail/auth" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleGmailAuthRedirect } = await import(
            "./connectors/gmail.js"
          );
          const result = handleGmailAuthRedirect();
          if (result.redirect) {
            res.writeHead(302, { Location: result.redirect });
            res.end();
          } else {
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          }
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/gmail" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleGmailDisconnect } = await import(
            "./connectors/gmail.js"
          );
          const result = await handleGmailDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/gmail/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleGmailTest } = await import("./connectors/gmail.js");
          const result = await handleGmailTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── GitHub MCP connector routes ─────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/github/auth" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleGithubAuthorize } = await import(
            "./connectors/github.js"
          );
          const result = await handleGithubAuthorize();
          if (result.redirect) {
            res.writeHead(302, { Location: result.redirect });
            res.end();
          } else {
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          }
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/github/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleGithubTest } = await import("./connectors/github.js");
          const result = await handleGithubTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/github" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleGithubDisconnect } = await import(
            "./connectors/github.js"
          );
          const result = await handleGithubDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── Sentry MCP connector routes ─────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/sentry/auth" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleSentryAuthorize } = await import(
            "./connectors/sentry.js"
          );
          const result = await handleSentryAuthorize();
          if (result.redirect) {
            res.writeHead(302, { Location: result.redirect });
            res.end();
          } else {
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          }
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/sentry/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleSentryCallback } = await import(
            "./connectors/sentry.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleSentryCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/sentry/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleSentryTest } = await import("./connectors/sentry.js");
          const result = await handleSentryTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/sentry" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleSentryDisconnect } = await import(
            "./connectors/sentry.js"
          );
          const result = await handleSentryDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── Linear MCP connector routes ─────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/linear/auth" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleLinearAuthorize } = await import(
            "./connectors/linear.js"
          );
          const result = await handleLinearAuthorize();
          if (result.redirect) {
            res.writeHead(302, { Location: result.redirect });
            res.end();
          } else {
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          }
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/linear/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleLinearCallback } = await import(
            "./connectors/linear.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleLinearCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/linear/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleLinearTest } = await import("./connectors/linear.js");
          const result = await handleLinearTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/linear" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleLinearDisconnect } = await import(
            "./connectors/linear.js"
          );
          const result = await handleLinearDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── Slack connector routes ──────────────────────────────────────
      if (
        (parsedUrl.pathname === "/connections/slack/auth" ||
          parsedUrl.pathname === "/connections/slack/authorize") &&
        req.method === "GET"
      ) {
        const { handleSlackAuthorize } = await import("./connectors/slack.js");
        const result = handleSlackAuthorize();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
        return;
      }
      if (
        parsedUrl.pathname === "/connections/slack/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleSlackTest } = await import("./connectors/slack.js");
          const result = await handleSlackTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/slack" &&
        req.method === "DELETE"
      ) {
        const { handleSlackDisconnect } = await import("./connectors/slack.js");
        const result = handleSlackDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Discord connector routes ───────────────────────────────────
      if (
        (parsedUrl.pathname === "/connections/discord/auth" ||
          parsedUrl.pathname === "/connections/discord/authorize") &&
        req.method === "GET"
      ) {
        const { handleDiscordAuthorize } = await import(
          "./connectors/discord.js"
        );
        const result = handleDiscordAuthorize();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
        return;
      }
      if (
        parsedUrl.pathname === "/connections/discord/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleDiscordCallback } = await import(
            "./connectors/discord.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleDiscordCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "text/html",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/discord/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleDiscordTest } = await import("./connectors/discord.js");
          const result = await handleDiscordTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/discord" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleDiscordDisconnect } = await import(
            "./connectors/discord.js"
          );
          const result = await handleDiscordDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── Asana connector routes ─────────────────────────────────────
      if (
        (parsedUrl.pathname === "/connections/asana/auth" ||
          parsedUrl.pathname === "/connections/asana/authorize") &&
        req.method === "GET"
      ) {
        const { handleAsanaAuthorize } = await import("./connectors/asana.js");
        const result = handleAsanaAuthorize();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
        return;
      }
      if (
        parsedUrl.pathname === "/connections/asana/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleAsanaCallback } = await import("./connectors/asana.js");
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleAsanaCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "text/html",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/asana/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleAsanaTest } = await import("./connectors/asana.js");
          const result = await handleAsanaTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/asana" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleAsanaDisconnect } = await import(
            "./connectors/asana.js"
          );
          const result = await handleAsanaDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── Notion routes ──────────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/notion/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handleNotionConnect } = await import(
              "./connectors/notion.js"
            );
            const result = await handleNotionConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }
      if (
        parsedUrl.pathname === "/connections/notion/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleNotionTest } = await import("./connectors/notion.js");
          const result = await handleNotionTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/notion" &&
        req.method === "DELETE"
      ) {
        const { handleNotionDisconnect } = await import(
          "./connectors/notion.js"
        );
        const result = handleNotionDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Confluence routes ───────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/confluence/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handleConfluenceConnect } = await import(
              "./connectors/confluence.js"
            );
            const result = await handleConfluenceConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }
      if (
        parsedUrl.pathname === "/connections/confluence/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleConfluenceTest } = await import(
            "./connectors/confluence.js"
          );
          const result = await handleConfluenceTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/confluence" &&
        req.method === "DELETE"
      ) {
        const { handleConfluenceDisconnect } = await import(
          "./connectors/confluence.js"
        );
        const result = handleConfluenceDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Zendesk routes ──────────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/zendesk/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handleZendeskConnect } = await import(
              "./connectors/zendesk.js"
            );
            const result = await handleZendeskConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }
      if (
        parsedUrl.pathname === "/connections/zendesk/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleZendeskTest } = await import("./connectors/zendesk.js");
          const result = await handleZendeskTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/zendesk" &&
        req.method === "DELETE"
      ) {
        const { handleZendeskDisconnect } = await import(
          "./connectors/zendesk.js"
        );
        const result = handleZendeskDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Intercom routes ─────────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/intercom/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handleIntercomConnect } = await import(
              "./connectors/intercom.js"
            );
            const result = await handleIntercomConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }
      if (
        parsedUrl.pathname === "/connections/intercom/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleIntercomTest } = await import(
            "./connectors/intercom.js"
          );
          const result = await handleIntercomTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/intercom" &&
        req.method === "DELETE"
      ) {
        const { handleIntercomDisconnect } = await import(
          "./connectors/intercom.js"
        );
        const result = handleIntercomDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── HubSpot routes ─────────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/hubspot/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handleHubSpotConnect } = await import(
              "./connectors/hubspot.js"
            );
            const result = await handleHubSpotConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }

      if (
        parsedUrl.pathname === "/connections/hubspot/test" &&
        req.method === "POST"
      ) {
        const { handleHubSpotTest } = await import("./connectors/hubspot.js");
        const result = await handleHubSpotTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      if (
        parsedUrl.pathname === "/connections/hubspot" &&
        req.method === "DELETE"
      ) {
        const { handleHubSpotDisconnect } = await import(
          "./connectors/hubspot.js"
        );
        const result = handleHubSpotDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Datadog routes ─────────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/datadog/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handleDatadogConnect } = await import(
              "./connectors/datadog.js"
            );
            const result = await handleDatadogConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }

      if (
        parsedUrl.pathname === "/connections/datadog/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleDatadogTest } = await import("./connectors/datadog.js");
          const result = await handleDatadogTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      if (
        parsedUrl.pathname === "/connections/datadog" &&
        req.method === "DELETE"
      ) {
        const { handleDatadogDisconnect } = await import(
          "./connectors/datadog.js"
        );
        const result = handleDatadogDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── PagerDuty routes ───────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/pagerduty/connect" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const { handlePagerDutyConnect } = await import(
              "./connectors/pagerduty.js"
            );
            const result = await handlePagerDutyConnect(
              Buffer.concat(chunks).toString("utf-8"),
            );
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }

      if (
        parsedUrl.pathname === "/connections/pagerduty/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handlePagerDutyTest } = await import(
            "./connectors/pagerduty.js"
          );
          const result = await handlePagerDutyTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      if (
        parsedUrl.pathname === "/connections/pagerduty" &&
        req.method === "DELETE"
      ) {
        const { handlePagerDutyDisconnect } = await import(
          "./connectors/pagerduty.js"
        );
        const result = handlePagerDutyDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Stripe routes ───────────────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/stripe/connect" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          void (async () => {
            const { handleStripeConnect } = await import(
              "./connectors/stripe.js"
            );
            const result = await handleStripeConnect(body);
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          })();
        });
        return;
      }

      if (
        parsedUrl.pathname === "/connections/stripe/test" &&
        req.method === "POST"
      ) {
        const { handleStripeTest } = await import("./connectors/stripe.js");
        const result = await handleStripeTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      if (
        parsedUrl.pathname === "/connections/stripe" &&
        req.method === "DELETE"
      ) {
        const { handleStripeDisconnect } = await import(
          "./connectors/stripe.js"
        );
        const result = handleStripeDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
        return;
      }

      // ── Google Calendar routes ──────────────────────────────────────
      if (
        parsedUrl.pathname === "/connections/google-calendar/auth" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleCalendarAuthRedirect } = await import(
            "./connectors/googleCalendar.js"
          );
          const result = handleCalendarAuthRedirect();
          if (result.redirect) {
            res.writeHead(302, { Location: result.redirect });
            res.end();
          } else {
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          }
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-calendar/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleCalendarCallback } = await import(
            "./connectors/googleCalendar.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleCalendarCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-calendar/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleCalendarTest } = await import(
            "./connectors/googleCalendar.js"
          );
          const result = await handleCalendarTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-calendar" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleCalendarDisconnect } = await import(
            "./connectors/googleCalendar.js"
          );
          const result = await handleCalendarDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      if (
        parsedUrl.pathname === "/connections/google-drive/auth" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleDriveAuthRedirect } = await import(
            "./connectors/googleDrive.js"
          );
          const result = handleDriveAuthRedirect();
          if (result.redirect) {
            res.writeHead(302, { Location: result.redirect });
            res.end();
          } else {
            res.writeHead(result.status, {
              "Content-Type": result.contentType ?? "application/json",
            });
            res.end(result.body);
          }
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-drive/callback" &&
        req.method === "GET"
      ) {
        void (async () => {
          const { handleDriveCallback } = await import(
            "./connectors/googleDrive.js"
          );
          const code = parsedUrl.searchParams.get("code");
          const state = parsedUrl.searchParams.get("state");
          const error = parsedUrl.searchParams.get("error");
          const result = await handleDriveCallback(code, state, error);
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-drive/test" &&
        req.method === "POST"
      ) {
        void (async () => {
          const { handleDriveTest } = await import(
            "./connectors/googleDrive.js"
          );
          const result = await handleDriveTest();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }
      if (
        parsedUrl.pathname === "/connections/google-drive" &&
        req.method === "DELETE"
      ) {
        void (async () => {
          const { handleDriveDisconnect } = await import(
            "./connectors/googleDrive.js"
          );
          const result = await handleDriveDisconnect();
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        })();
        return;
      }

      // ── Inbox routes ────────────────────────────────────────────────────
      if (parsedUrl.pathname === "/inbox" && req.method === "GET") {
        void (async () => {
          try {
            const { readdir, readFile, stat } = await import(
              "node:fs/promises"
            );
            const { existsSync } = await import("node:fs");
            const inboxDir = path.join(os.homedir(), ".patchwork", "inbox");
            if (!existsSync(inboxDir)) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ items: [] }));
              return;
            }
            const files = (await readdir(inboxDir)).filter((f) =>
              f.endsWith(".md"),
            );
            const items = await Promise.all(
              files.map(async (name) => {
                const filePath = path.join(inboxDir, name);
                const [content, stats] = await Promise.all([
                  readFile(filePath, "utf8"),
                  stat(filePath),
                ]);
                const stripped = content
                  .split("\n")
                  .filter((l) => !l.startsWith("#"))
                  .join("\n")
                  .trim();
                return {
                  name,
                  path: filePath,
                  modifiedAt: stats.mtime.toISOString(),
                  preview: stripped.slice(0, 200),
                };
              }),
            );
            items.sort(
              (a, b) =>
                new Date(b.modifiedAt).getTime() -
                new Date(a.modifiedAt).getTime(),
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ items }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })();
        return;
      }

      const inboxFileMatch = parsedUrl.pathname?.match(
        /^\/inbox\/([^/]+\.md)$/,
      );
      if (inboxFileMatch && req.method === "GET") {
        void (async () => {
          try {
            const { readFile, stat } = await import("node:fs/promises");
            const filename = decodeURIComponent(inboxFileMatch[1] ?? "");
            // Prevent path traversal — filename must not contain directory separators
            if (filename.includes("/") || filename.includes("\\")) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid filename" }));
              return;
            }
            const filePath = path.join(
              os.homedir(),
              ".patchwork",
              "inbox",
              filename,
            );
            const [content, stats] = await Promise.all([
              readFile(filePath, "utf8"),
              stat(filePath),
            ]);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                name: filename,
                content,
                modifiedAt: stats.mtime.toISOString(),
              }),
            );
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Not found" }));
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          }
        })();
        return;
      }
      // ── End inbox routes ─────────────────────────────────────────────────

      const recipeNameRunMatch =
        req.method === "POST"
          ? /^\/recipes\/([^/]+)\/run$/.exec(parsedUrl.pathname)
          : null;
      if (recipeNameRunMatch) {
        const nameFromPath = decodeURIComponent(recipeNameRunMatch[1] ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const parsed = body
                ? (JSON.parse(body) as {
                    vars?: Record<string, string>;
                    inputs?: Record<string, string>;
                  })
                : {};
              const varsRaw = parsed.vars ?? parsed.inputs;
              const vars =
                varsRaw &&
                typeof varsRaw === "object" &&
                !Array.isArray(varsRaw)
                  ? (varsRaw as Record<string, string>)
                  : undefined;
              if (!this.runRecipeFn) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error:
                      "Recipe execution unavailable — requires --claude-driver subprocess",
                  }),
                );
                return;
              }
              const result = await this.runRecipeFn(nameFromPath, vars);
              res.writeHead(result.ok ? 200 : 400, {
                "Content-Type": "application/json",
              });
              res.end(JSON.stringify(result));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Invalid JSON body" }),
              );
            }
          })();
        });
        return;
      }
      if (parsedUrl.pathname === "/recipes/run" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const parsed = JSON.parse(body || "{}") as {
                name?: string;
                vars?: Record<string, string>;
              };
              const name = parsed.name;
              const vars =
                parsed.vars &&
                typeof parsed.vars === "object" &&
                !Array.isArray(parsed.vars)
                  ? (parsed.vars as Record<string, string>)
                  : undefined;
              if (typeof name !== "string" || !name) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "name required" }));
                return;
              }
              if (!this.runRecipeFn) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error:
                      "Recipe execution unavailable — requires --claude-driver subprocess",
                  }),
                );
                return;
              }
              const result = await this.runRecipeFn(name, vars);
              res.writeHead(result.ok ? 200 : 400, {
                "Content-Type": "application/json",
              });
              res.end(JSON.stringify(result));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Invalid JSON body" }),
              );
            }
          })();
        });
        return;
      }
      if (
        parsedUrl.pathname === "/activation-metrics" &&
        req.method === "GET"
      ) {
        try {
          const metrics = loadActivationMetrics();
          const summary = computeActivationSummary(metrics);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ metrics, summary }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/runs" && req.method === "GET") {
        try {
          const sp = parsedUrl.searchParams;
          const limitRaw = sp.get("limit");
          const afterRaw = sp.get("after");
          const trigger = sp.get("trigger");
          const status = sp.get("status");
          const recipe = sp.get("recipe");
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
          const after = afterRaw ? Number.parseInt(afterRaw, 10) : Number.NaN;
          const runs =
            this.runsFn?.({
              ...(Number.isFinite(limit) && { limit }),
              ...(trigger && { trigger }),
              ...(status && { status }),
              ...(recipe && { recipe }),
              ...(Number.isFinite(after) && { after }),
            }) ?? [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ runs }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      // GET /runs/:seq — single run detail (includes stepResults if present)
      const runDetailMatch =
        req.method === "GET"
          ? /^\/runs\/(\d+)$/.exec(parsedUrl.pathname)
          : null;
      if (runDetailMatch?.[1]) {
        const seq = Number.parseInt(runDetailMatch[1], 10);
        try {
          const run = this.runDetailFn?.(seq) ?? null;
          if (!run) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not_found" }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ run }));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      // POST /runs/:seq/replay — VD-4 mocked replay. Re-runs the recipe
      // with all tool/agent execution intercepted to return captured
      // outputs from the original run. No external IO, no side effects.
      // Real-mode replay is not exposed here yet — must ship separately
      // with confirmation UX + kill-switch interaction.
      const runReplayMatch =
        req.method === "POST"
          ? /^\/runs\/(\d+)\/replay$/.exec(parsedUrl.pathname)
          : null;
      if (runReplayMatch?.[1]) {
        const seq = Number.parseInt(runReplayMatch[1], 10);
        try {
          if (!this.runReplayFn) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "replay_unavailable" }));
            return;
          }
          const result = await this.runReplayFn(seq);
          if (result.error === "run_not_found") {
            res.writeHead(404, { "Content-Type": "application/json" });
          } else if (!result.ok) {
            res.writeHead(500, { "Content-Type": "application/json" });
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }
      // GET /runs/:seq/plan — dry-run plan for the recipe that produced this run
      const runPlanMatch =
        req.method === "GET"
          ? /^\/runs\/(\d+)\/plan$/.exec(parsedUrl.pathname)
          : null;
      if (runPlanMatch?.[1]) {
        const seq = Number.parseInt(runPlanMatch[1], 10);
        try {
          const run = this.runDetailFn?.(seq) ?? null;
          if (!run) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "run_not_found" }));
            return;
          }
          if (!this.runPlanFn) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "plan_unavailable" }));
            return;
          }
          // triggerSource appends ":agent" suffix — strip before file lookup
          const recipeName = (run.recipeName as string).replace(/:agent$/, "");
          const plan = await this.runPlanFn(recipeName);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ plan }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status =
            msg.includes("not found") || msg.includes("ENOENT") ? 404 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }
      if (req.url === "/recipes" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            const draft = JSON.parse(body || "{}") as RecipeDraft;
            if (typeof draft.name !== "string" || !draft.name) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "name required" }));
              return;
            }
            if (!this.saveRecipeFn) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "Recipe saving unavailable",
                }),
              );
              return;
            }
            const result = this.saveRecipeFn(draft);
            res.writeHead(result.ok ? 201 : 400, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          }
        });
        return;
      }
      const recipePatchMatch = /^\/recipes\/([^/]+)$/.exec(parsedUrl.pathname);
      if (recipePatchMatch && req.method === "PATCH") {
        const name = decodeURIComponent(recipePatchMatch[1] ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as { enabled?: boolean };
            if (typeof body.enabled !== "boolean") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "enabled (boolean) required",
                }),
              );
              return;
            }
            if (!this.setRecipeEnabledFn) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Not available" }));
              return;
            }
            const result = this.setRecipeEnabledFn(name, body.enabled);
            res.writeHead(result.ok ? 200 : 400, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          }
        });
        return;
      }
      if (parsedUrl.pathname === "/recipes/lint" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as {
              content?: string;
            };
            if (typeof body?.content !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "content (string) required",
                }),
              );
              return;
            }
            if (!this.lintRecipeContentFn) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "Recipe lint unavailable",
                }),
              );
              return;
            }
            const result = this.lintRecipeContentFn(body.content);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          }
        });
        return;
      }
      const recipeContentMatch = /^\/recipes\/([^/]+)$/.exec(
        parsedUrl.pathname,
      );
      if (recipeContentMatch && req.method === "GET") {
        const name = decodeURIComponent(recipeContentMatch[1] ?? "");
        if (!this.loadRecipeContentFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ ok: false, error: "Recipe content unavailable" }),
          );
          return;
        }
        const result = this.loadRecipeContentFn(name);
        if (!result) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Recipe not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      if (recipeContentMatch && req.method === "PUT") {
        const name = decodeURIComponent(recipeContentMatch[1] ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as { content?: string };
            if (typeof body.content !== "string") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "content (string) required",
                }),
              );
              return;
            }
            if (!this.saveRecipeContentFn) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "Recipe content saving unavailable",
                }),
              );
              return;
            }
            const result = this.saveRecipeContentFn(name, body.content);
            res.writeHead(result.ok ? 200 : 400, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          }
        });
        return;
      }
      if (recipeContentMatch && req.method === "DELETE") {
        const name = decodeURIComponent(recipeContentMatch[1] ?? "");
        if (!this.deleteRecipeContentFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe deletion unavailable",
            }),
          );
          return;
        }
        const result = this.deleteRecipeContentFn(name);
        const status = result.ok
          ? 200
          : result.error === "Recipe not found"
            ? 404
            : 400;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === "/recipes" && req.method === "GET") {
        try {
          const data = this.recipesFn?.() ?? { recipesDir: null, recipes: [] };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/templates" && req.method === "GET") {
        try {
          const now = Date.now();
          if (
            !this._templatesCache ||
            now - this._templatesCacheTs > 5 * 60 * 1000
          ) {
            const ghRes = await fetch(
              "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json",
            );
            if (!ghRes.ok) {
              throw new Error(`GitHub returned ${ghRes.status}`);
            }
            this._templatesCache = (await ghRes.json()) as unknown;
            this._templatesCacheTs = now;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this._templatesCache));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/recipes/install" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          try {
            const { source } = JSON.parse(body) as { source?: string };
            if (!source) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Missing source field" }),
              );
              return;
            }
            const githubPrefix = "github:patchworkos/recipes/recipes/";
            let fetchUrl: string;
            let recipeName: string;
            if (source.startsWith(githubPrefix)) {
              recipeName = source.slice(githubPrefix.length);
              fetchUrl = `https://raw.githubusercontent.com/patchworkos/recipes/main/recipes/${recipeName}/${recipeName}.yaml`;
            } else if (source.startsWith("https://")) {
              fetchUrl = source;
              const urlParts = fetchUrl.split("/");
              recipeName = (urlParts[urlParts.length - 1] ?? "recipe").replace(
                /\.ya?ml$/i,
                "",
              );
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "Unsupported source format",
                }),
              );
              return;
            }
            const yamlRes = await fetch(fetchUrl);
            if (!yamlRes.ok) {
              throw new Error(
                `Fetch failed: ${yamlRes.status} ${yamlRes.statusText}`,
              );
            }
            const yamlText = await yamlRes.text();
            const tmpFile = path.join(
              os.tmpdir(),
              `patchwork-install-${Date.now()}-${recipeName}.yaml`,
            );
            const { writeFileSync, mkdirSync, unlinkSync } = await import(
              "node:fs"
            );
            writeFileSync(tmpFile, yamlText, "utf-8");
            let result: { action: "created" | "replaced"; name: string };
            try {
              const recipesDir = path.join(
                os.homedir(),
                ".patchwork",
                "recipes",
              );
              mkdirSync(recipesDir, { recursive: true });
              const { installRecipeFromFile } = await import(
                "./recipes/installer.js"
              );
              const installResult = installRecipeFromFile(tmpFile, {
                recipesDir,
              });
              result = { action: installResult.action, name: recipeName };
            } finally {
              try {
                unlinkSync(tmpFile);
              } catch {
                // best-effort cleanup
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        });
        return;
      }
      const sessionDetailMatch = /^\/sessions\/([A-Za-z0-9-]+)$/.exec(
        parsedUrl.pathname,
      );
      if (sessionDetailMatch && req.method === "GET") {
        const id = sessionDetailMatch[1] as string;
        try {
          const data = this.sessionDetailFn?.(id);
          if (!data?.summary) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unknown sessionId" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/sessions" && req.method === "GET") {
        try {
          if (!this.sessionsFn) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessions not available" }));
            return;
          }
          const data = this.sessionsFn();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (parsedUrl.pathname === "/settings" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as {
              webhookUrl?: string;
              approvalGate?: string;
              driver?: string;
              model?: string;
              localEndpoint?: string;
              localModel?: string;
              apiKey?: { provider: string; key: string };
              pushServiceUrl?: string;
              pushServiceToken?: string;
              pushServiceBaseUrl?: string;
            };
            const hasWebhookUpdate = body.webhookUrl !== undefined;
            const raw = hasWebhookUpdate
              ? (body.webhookUrl?.trim() ?? "")
              : undefined;
            if (raw !== undefined && raw !== "" && !/^https:\/\/.+/.test(raw)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "webhookUrl must be HTTPS" }));
              return;
            }
            const gateRaw = body.approvalGate;
            if (
              gateRaw !== undefined &&
              gateRaw !== "off" &&
              gateRaw !== "high" &&
              gateRaw !== "all"
            ) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: 'approvalGate must be "off", "high", or "all"',
                }),
              );
              return;
            }
            const configPath = patchworkConfigPath();
            const cfg = loadPatchworkConfig(configPath);
            cfg.dashboard = {
              port: cfg.dashboard?.port ?? 3000,
              requireApproval: cfg.dashboard?.requireApproval ?? ["high"],
              pushNotifications: cfg.dashboard?.pushNotifications ?? false,
              webhookUrl: hasWebhookUpdate
                ? raw || undefined
                : cfg.dashboard?.webhookUrl,
            };
            if (gateRaw !== undefined) {
              cfg.approvalGate = gateRaw as "off" | "high" | "all";
              this.approvalGate = gateRaw as "off" | "high" | "all";
            }
            const driverRaw = body.driver;
            if (driverRaw !== undefined) {
              const validDrivers = [
                "subprocess",
                "api",
                "openai",
                "grok",
                "gemini",
                "none",
              ];
              if (!validDrivers.includes(driverRaw)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: `driver must be one of: ${validDrivers.join(", ")}`,
                  }),
                );
                return;
              }
              const driver = driverRaw as NonNullable<
                PatchworkConfig["driver"]
              >;
              cfg.driver = driver;
              saveBridgeConfigDriver(driver, this.bridgeConfigPath);
            }
            if (body.model !== undefined) {
              const validModels = [
                "claude",
                "openai",
                "gemini",
                "grok",
                "local",
              ];
              if (!validModels.includes(body.model)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: `model must be one of: ${validModels.join(", ")}`,
                  }),
                );
                return;
              }
              cfg.model = body.model as PatchworkConfig["model"];
              if (body.model === "local") {
                if (body.localEndpoint !== undefined)
                  cfg.localEndpoint = body.localEndpoint.trim() || undefined;
                if (body.localModel !== undefined)
                  cfg.localModel = body.localModel.trim() || undefined;
              }
            }
            if (body.apiKey) {
              const { provider, key } = body.apiKey;
              const validProviders = ["anthropic", "openai", "google", "xai"];
              if (
                !validProviders.includes(provider) ||
                typeof key !== "string"
              ) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({ error: "Invalid apiKey provider or key" }),
                );
                return;
              }
              cfg.apiKeys = { ...cfg.apiKeys, [provider]: key || undefined };
            }
            savePatchworkConfig(cfg, configPath);
            if (hasWebhookUpdate) {
              this.approvalWebhookUrl = raw || undefined;
            }
            if (body.pushServiceUrl !== undefined) {
              const pushUrl = body.pushServiceUrl.trim();
              if (pushUrl && !pushUrl.startsWith("https://")) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({ error: "pushServiceUrl must be HTTPS" }),
                );
                return;
              }
              this.pushServiceUrl = pushUrl || undefined;
            }
            if (body.pushServiceToken !== undefined) {
              this.pushServiceToken = body.pushServiceToken.trim() || undefined;
            }
            if (body.pushServiceBaseUrl !== undefined) {
              this.pushServiceBaseUrl =
                body.pushServiceBaseUrl.trim() || undefined;
            }
            const restartRequired =
              driverRaw !== undefined ||
              body.apiKey !== undefined ||
              body.model !== undefined;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, restartRequired }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        });
        return;
      }
      // CC hook notify endpoint — lightweight alternative to full MCP session for hook wiring.
      if (parsedUrl.pathname === "/notify" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            const parsed = JSON.parse(body) as {
              event?: string;
              args?: Record<string, string>;
            };
            const event = parsed.event ?? "";
            const args = parsed.args ?? {};
            if (!this.notifyFn) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "Automation not enabled",
                }),
              );
              return;
            }
            const result = this.notifyFn(event, args);
            res.writeHead(result.ok ? 200 : 400, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          }
        });
        return;
      }
      // Single-approval detail lookup for the dashboard detail page.
      const detailMatch = /^\/approvals\/([A-Za-z0-9-]+)$/.exec(
        parsedUrl.pathname,
      );
      if (detailMatch && req.method === "GET") {
        const callId = detailMatch[1] as string;
        try {
          const data = this.approvalDetailFn?.(callId);
          if (!data || (!data.pending && !data.decision)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unknown callId" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      // SSE stream for live approval queue updates.
      if (parsedUrl.pathname === "/approvals/stream" && req.method === "GET") {
        handleApprovalsStream(
          res as unknown as import("./approvalHttp.js").SseWriter,
          { queue: getApprovalQueue() },
          parsedUrl.searchParams.get("session"),
        );
        return;
      }

      // Patchwork approval surface — PreToolUse hook + dashboard approve/reject.
      // Bearer auth already checked above.
      if (
        parsedUrl.pathname === "/approvals" ||
        parsedUrl.pathname === "/cc-permissions" ||
        /^\/(approve|reject)\/[A-Za-z0-9-]+$/.test(parsedUrl.pathname)
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          let parsedBody: Record<string, unknown> | undefined;
          if (chunks.length > 0) {
            try {
              parsedBody = JSON.parse(
                Buffer.concat(chunks).toString("utf-8"),
              ) as Record<string, unknown>;
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid JSON body" }));
              return;
            }
          }
          try {
            const result = await routeApprovalRequest(
              {
                method: req.method ?? "GET",
                path: parsedUrl.pathname,
                body: parsedBody,
                query: parsedUrl.searchParams,
                approvalToken: req.headers["x-approval-token"] as
                  | string
                  | undefined,
              },
              {
                queue: getApprovalQueue(),
                workspace: process.cwd(),
                managedSettingsPath: this.managedSettingsPath,
                onDecision: this.onApprovalDecision,
                webhookUrl: this.approvalWebhookUrl,
                approvalGate: this.approvalGate,
                pushServiceUrl: this.pushServiceUrl,
                pushServiceToken: this.pushServiceToken,
                pushServiceBaseUrl: this.pushServiceBaseUrl,
              },
            );
            res.writeHead(result.status, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(result.body));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        });
        return;
      }
      // Quick-task launch endpoint — mirrors /notify pattern. Bearer auth already checked above.
      if (
        parsedUrl.pathname === "/launch-quick-task" &&
        req.method === "POST"
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = Buffer.concat(chunks).toString("utf-8");
              const parsed = JSON.parse(body) as {
                presetId?: string;
                source?: string;
              };
              const presetId = parsed.presetId;
              const source = parsed.source ?? "cli";
              if (typeof presetId !== "string" || !presetId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: "presetId required",
                  }),
                );
                return;
              }
              if (!this.launchQuickTaskFn) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error:
                      "Quick tasks unavailable — requires --claude-driver subprocess",
                  }),
                );
                return;
              }
              const result = await this.launchQuickTaskFn(presetId, source);
              res.writeHead(result.ok ? 200 : 429, {
                "Content-Type": "application/json",
              });
              res.end(JSON.stringify(result));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "Invalid JSON body" }),
              );
            }
          })();
        });
        return;
      }
      // MCP Streamable HTTP transport — POST/GET/DELETE /mcp.
      // Bearer auth is already checked above, so all requests here are authenticated.
      // The Mcp-Session-Id header routes to the correct session.
      // OPTIONS is handled before auth so CORS preflight works.
      if (parsedUrl.pathname === "/mcp" && this.httpMcpHandler) {
        if (
          req.method === "POST" ||
          req.method === "GET" ||
          req.method === "DELETE"
        ) {
          this.httpMcpHandler(req, res).catch((err) => {
            this.logger.error(
              `HTTP MCP handler error: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    // Do NOT pass server — we handle upgrade manually for pre-handshake auth
    this.wss = new WsServer({
      noServer: true,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });

    // Authenticate on upgrade BEFORE completing the WebSocket handshake
    this.httpServer.on("upgrade", (request, socket, head) => {
      // Prevent unhandled error events on the raw socket during upgrade
      socket.on("error", () => socket.destroy());

      // Validate Host header to defend against DNS rebinding.
      // Strip port suffix, handling both IPv4 (host:port) and IPv6 ([::1]:port).
      const rawHost = request.headers.host ?? "";
      const host = rawHost.startsWith("[")
        ? rawHost.slice(0, rawHost.indexOf("]") + 1) // [::1]:port → [::1]
        : rawHost.replace(/:\d+$/, ""); // host:port → host
      if (!host || !this.allowedHosts.has(host)) {
        this.logger.warn(
          `Rejected connection with invalid Host header: ${host}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      // Reject browser-originated connections — a browser tab on any origin can
      // connect to ws://localhost:<port> but will always send an Origin header.
      // VS Code extension and Claude Code CLI connections either omit Origin or
      // send "vscode-file://" / "vscode-webview://". Any other origin is a browser
      // page attempting a cross-origin WebSocket and is rejected here as defense-
      // in-depth (the auth token is the primary guard).
      const origin = request.headers.origin;
      if (
        origin !== undefined &&
        !origin.startsWith("vscode-file://") &&
        !origin.startsWith("vscode-webview://") &&
        !origin.startsWith("vscode-app://")
      ) {
        this.logger.warn(
          `Rejected connection with unexpected Origin header: ${origin}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const now = Date.now();

      // Check for extension connection (distinct header)
      const extensionToken = request.headers["x-claude-ide-extension"];
      if (
        typeof extensionToken === "string" &&
        timingSafeTokenCompare(extensionToken, this.authToken)
      ) {
        // Rate limit per client type to prevent connection-storm DoS
        if (
          now - this.lastExtensionConnectionTime <
          MIN_CONNECTION_INTERVAL_MS
        ) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
          socket.destroy();
          return;
        }
        this.lastExtensionConnectionTime = now;
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          const alive = ws as AliveWebSocket;
          alive.isAlive = true;
          alive.missedPongs = 0;
          alive.lastPongTime = Date.now();
          enableTcpKeepalive(ws);
          setupPongHandler(alive);
          this.emit("extension", ws);
          ws.once("close", () => {
            this.lastExtensionConnectionTime = 0;
          });
        });
        return;
      }

      // Check for Claude Code connection
      const token = request.headers["x-claude-code-ide-authorization"];
      if (
        typeof token !== "string" ||
        !timingSafeTokenCompare(token, this.authToken)
      ) {
        this.logger.warn("Rejected unauthorized WebSocket upgrade");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // Rate limit per client type to prevent connection-storm DoS
      if (now - this.lastClaudeConnectionTime < MIN_CONNECTION_INTERVAL_MS) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }
      this.lastClaudeConnectionTime = now;

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (raw, req: http.IncomingMessage) => {
      const ws = raw as AliveWebSocket;
      // Propagate the client-supplied session ID (for grace-period resumption) so
      // the bridge handler can look up an in-grace session without needing the raw request.
      const incomingSessionId = req.headers["x-claude-code-session-id"];
      if (
        typeof incomingSessionId === "string" &&
        SESSION_ID_RE.test(incomingSessionId)
      ) {
        ws.clientSessionId = incomingSessionId;
      }
      this.logger.debug("Claude Code connected");
      ws.isAlive = true;
      ws.missedPongs = 0;
      ws.lastPongTime = Date.now();
      ws.lastPingTime = 0;
      enableTcpKeepalive(raw);
      setupPongHandler(ws);
      ws.on("close", (code, reason) => {
        // Strip control chars (newlines, ANSI codes) to prevent log injection.
        // Cap at 123 bytes — RFC 6455 §7.4 limit for close reason payloads.
        const reasonStr = reason?.length
          ? reason
              .toString()
              .replace(/[\x00-\x1f\x7f]/g, "")
              .slice(0, 123)
          : "(none)";
        const lastSeen = ws.lastPongTime
          ? `${Math.round((Date.now() - ws.lastPongTime) / 1000)}s ago`
          : "never";
        this.logger.info(
          `Claude Code WebSocket closed — code=${code} reason="${reasonStr}" ` +
            `disconnectReason=${ws.disconnectReason ?? "client_initiated"} ` +
            `missedPongs=${ws.missedPongs ?? 0} lastPong=${lastSeen}`,
        );
      });
      ws.on("error", (err) => {
        this.logger.error(`WebSocket client error: ${err.message}`);
      });
      (ws as WebSocket & { remoteAddr?: string }).remoteAddr =
        req.socket.remoteAddress;
      this.emit("connection", ws);
    });
  }

  async listen(port: number, bindAddress = "127.0.0.1"): Promise<number> {
    const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
    if (!LOOPBACK.has(bindAddress)) {
      this.logger.warn(
        `WARNING: Bridge bound to ${bindAddress} — not a loopback address. Any host that can reach this address and obtain the auth token can connect. Use --bind 127.0.0.1 (default) for local-only access.`,
      );
    }
    // Mitigate slow-loris attacks: bound the headers phase.
    // requestTimeout is NOT disabled globally — SSE handlers must disable it
    // per-response via `res.socket?.setTimeout(0)` for their own long-lived stream.
    this.httpServer.headersTimeout = 5_000;
    this.httpServer.requestTimeout = 30_000;
    return new Promise((resolve, reject) => {
      this.httpServer
        .listen(port, bindAddress, () => {
          const addr = this.httpServer.address();
          if (!addr || typeof addr === "string") {
            if (this.pingInterval) {
              clearInterval(this.pingInterval);
              this.pingInterval = null;
            }
            reject(new Error("Unexpected server address"));
            return;
          }
          // Ping clients every pingIntervalMs (default 30s); terminate after 4 missed pongs (120s tolerance)
          this.pingInterval = setInterval(
            () => {
              const now = Date.now();
              for (const raw of this.wss.clients) {
                const client = raw as AliveWebSocket;
                // Sleep/wake detection: if timer fired much later than expected,
                // the system likely slept. Reset and probe instead of killing.
                if (client.lastPingTime && now - client.lastPingTime > 45_000) {
                  client.missedPongs = 0;
                  client.isAlive = false;
                  client.lastPingTime = now;
                  if (client.readyState === WebSocket.OPEN) {
                    client.ping(Buffer.from(now.toString()));
                  }
                  continue;
                }
                if (!client.isAlive) {
                  client.missedPongs = (client.missedPongs ?? 0) + 1;
                  if (client.missedPongs >= 4) {
                    client.disconnectReason = "pong_timeout";
                    this.logger.warn(
                      `Terminating unresponsive client — 4 missed pongs ` +
                        `lastPong=${client.lastPongTime ? `${Math.round((now - client.lastPongTime) / 1000)}s ago` : "never"}`,
                    );
                    client.terminate();
                    continue;
                  }
                }
                client.isAlive = false;
                client.lastPingTime = now;
                if (client.readyState === WebSocket.OPEN) {
                  client.ping(Buffer.from(now.toString()));
                }
              }
              // Enforce a minimum interval so a misconfigured value cannot spin
              // the event loop (setInterval(fn, 0) would fire on every tick).
              // 10 ms floor is low enough for tests, high enough to be safe.
            },
            Math.max(10, this.pingIntervalMs),
          );
          resolve(addr.port);
        })
        .on("error", reject);
    });
  }

  async findAndListen(
    preferredPort: number | null,
    bindAddress = "127.0.0.1",
  ): Promise<number> {
    if (preferredPort) {
      if (preferredPort < 1 || preferredPort > 65535) {
        this.logger.warn(
          `Invalid port ${preferredPort} (must be 1-65535), falling back to OS-assigned port`,
        );
        // Fall through to OS-assigned port below
      } else {
        return this.listen(preferredPort, bindAddress);
      }
    }
    // Port 0 lets the OS kernel assign a free port atomically
    return this.listen(0, bindAddress);
  }

  async close(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const client of this.wss.clients) {
      client.close(1001, "Server shutting down");
    }
    // Wait up to 2s for graceful disconnect, then force-terminate
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        for (const client of this.wss.clients) {
          client.terminate();
        }
        resolve();
      }, 2000);
      this.wss.close(() => {
        clearTimeout(forceTimer);
        resolve();
      });
    });
    // Drain idle keep-alive HTTP connections (Node 20+ native)
    this.httpServer.closeIdleConnections();
    await new Promise<void>((resolve) => {
      // Hard failsafe: force-close any remaining HTTP connections after 10s
      const hardTimer = setTimeout(() => {
        this.httpServer.closeAllConnections();
        resolve();
      }, 10_000);
      this.httpServer.close((err) => {
        clearTimeout(hardTimer);
        if (err) this.logger.error(`HTTP server close error: ${err.message}`);
        resolve();
      });
    });
  }
}
