/**
 * Connector route dispatcher — extracted from src/server.ts.
 *
 * Owns every `/connections/*` HTTP endpoint (auth start / OAuth callback /
 * test ping / disconnect / connect-with-body) for the 18 supported
 * connectors.
 *
 * Two entrypoints — the split exists because OAuth callbacks must run
 * BEFORE the bearer-auth gate (they're browser redirects from the vendor
 * with no Patchwork token), while CRUD routes must run AFTER it:
 *
 *   - `tryHandlePublicConnectorRoute` — `/connections/<vendor>/callback`
 *     routes. Server.ts calls this BEFORE bearer-auth.
 *   - `tryHandleConnectorRoute` — auth/test/disconnect/connect routes.
 *     Server.ts calls this AFTER bearer-auth.
 *
 * Mechanical lift — no behavior change:
 *   - Handler bodies are byte-identical to the original blocks save for
 *     wrapping a few non-IIFE call sites in `void (async()=>{...})()` so
 *     both functions can return boolean synchronously rather than
 *     Promise<boolean>. The microtask delay this introduces is invisible
 *     to clients — the parent request handler `return`s on a true result
 *     either way, and `res.end()` has always been async.
 *   - Pre-extraction grep confirmed zero `this.` references in either
 *     block, so no dependency injection was needed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { respond500 } from "./httpErrorResponse.js";
import { readBodyWithCap, respond413 } from "./recipeRoutes.js";

/**
 * Token-paste connector body cap. The legitimate payload is a small JSON
 * envelope (`{token: "...", workspace?: "..."}`) — cap at 16 KB so an
 * authenticated caller can't burn bridge heap streaming a multi-GB body
 * into the unbounded `req.on("data", ...)` handlers each connector route
 * used to have.
 */
const CONNECTOR_BODY_CAP = 16 * 1024;

/**
 * Short-lived in-memory cache for `GET /connections` (audit http-routes-5).
 *
 * `handleConnectionsList()` iterates every registered connector and calls
 * each `getStatus()`, which performs keychain reads / disk I/O. With 45+
 * connectors that is 45+ synchronous probes per request. The dashboard
 * polls this endpoint on every page load and on a timer, serializing dozens
 * of keychain probes on the event loop. A 5 s TTL collapses bursts of polls
 * into a single probe pass while staying fresh enough that a
 * just-completed connect/disconnect is reflected almost immediately —
 * and any mutating `/connections/*` request (POST/DELETE, OAuth callback)
 * eagerly invalidates the cache so changes never wait out the TTL.
 */
const CONNECTIONS_CACHE_TTL_MS = 5_000;
let connectionsCache: { ts: number; result: ConnectorHandlerResult } | null =
  null;

/** Drop the cached `GET /connections` payload — call after any mutation. */
function invalidateConnectionsCache(): void {
  connectionsCache = null;
}

interface ConnectorHandlerResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * Read the request body with a cap, dispatch to the connector's
 * `handle<Vendor>Connect(body)` function, and write the result. Replaces
 * the 8 near-identical inline blocks that previously each had an
 * unbounded `req.on("data", ...)` accumulation.
 *
 * `loadHandler` is a closure that returns the handler — kept this shape
 * so each call site preserves the lazy `await import()` of the connector
 * module (only loaded on first call, not at bridge startup).
 */
async function dispatchConnectorConnect(
  req: IncomingMessage,
  res: ServerResponse,
  loadHandler: () => Promise<(body: string) => Promise<ConnectorHandlerResult>>,
): Promise<void> {
  const read = await readBodyWithCap(req, CONNECTOR_BODY_CAP);
  if (!read.ok) {
    respond413(res, CONNECTOR_BODY_CAP);
    return;
  }
  try {
    const handler = await loadHandler();
    const result = await handler(read.body);
    res.writeHead(result.status, {
      "Content-Type": result.contentType ?? "application/json",
    });
    res.end(result.body);
  } catch (err) {
    respond500(res, err);
  }
}

/**
 * Try to handle a `/connections/<vendor>/callback` route. These are
 * unauthenticated browser redirects from the OAuth vendor and MUST run
 * before the bearer-auth gate. Returns true if the route was dispatched.
 */
export function tryHandlePublicConnectorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
): boolean {
  // Completing an OAuth callback flips a connector from disconnected →
  // connected, so drop the cached `GET /connections` payload (http-routes-5).
  if (
    parsedUrl.pathname.startsWith("/connections/") &&
    parsedUrl.pathname.endsWith("/callback")
  ) {
    invalidateConnectionsCache();
  }
  if (
    parsedUrl.pathname === "/connections/github/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleGithubCallback } = await import("./connectors/github.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleGithubCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/linear/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleLinearCallback } = await import("./connectors/linear.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleLinearCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/sentry/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleSentryCallback } = await import("./connectors/sentry.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleSentryCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-docs/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleDocsCallback } = await import(
          "./connectors/googleDocs.js"
        );
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleDocsCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/monday/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleMondayCallback } = await import("./connectors/monday.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleMondayCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/salesforce/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleSalesforceCallback } = await import(
          "./connectors/salesforce.js"
        );
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleSalesforceCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/slack/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleSlackCallback } = await import("./connectors/slack.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleSlackCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gmail/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleGmailCallback } = await import("./connectors/gmail.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleGmailCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "text/html",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  // Discord, Asana, GitLab — OAuth authorization-code connectors whose vendor
  // redirects back to these callback URLs with no Patchwork bearer token.
  // They must be registered here (pre-auth) so the browser redirect doesn't
  // hit the bearer-auth gate and get rejected with 401.
  if (
    parsedUrl.pathname === "/connections/discord/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/asana/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleAsanaCallback } = await import("./connectors/asana.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleAsanaCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "text/html",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gitlab/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleGitLabCallback } = await import("./connectors/gitlab.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleGitLabCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "text/html",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  return false;
}

/**
 * Try to handle a `/connections/*` route (auth start / test / disconnect /
 * connect-with-body). Returns true if the route was dispatched (caller
 * should `return` from the request handler), false if no route matched
 * (caller should fall through to other route checks).
 *
 * The actual response is written asynchronously inside an IIFE; this
 * function returns synchronously as soon as the route is recognized.
 */
export function tryHandleConnectorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
): boolean {
  // Any mutating `/connections/*` request (connect / disconnect / test) can
  // change a connector's reported status, so eagerly drop the cached list
  // (audit http-routes-5). The GET path below is the only reader.
  if (
    req.method !== "GET" &&
    (parsedUrl.pathname === "/connections" ||
      parsedUrl.pathname.startsWith("/connections/"))
  ) {
    invalidateConnectionsCache();
  }
  // ── Gmail / Connections endpoints ───────────────────────────────────────
  if (parsedUrl.pathname === "/connections" && req.method === "GET") {
    void (async () => {
      try {
        const now = Date.now();
        let result: ConnectorHandlerResult;
        if (
          connectionsCache &&
          now - connectionsCache.ts < CONNECTIONS_CACHE_TTL_MS
        ) {
          result = connectionsCache.result;
        } else {
          const { handleConnectionsList } = await import(
            "./connectors/gmail.js"
          );
          result = await handleConnectionsList();
          // Only cache successful list responses; transient errors should
          // be re-probed on the next request rather than pinned for the TTL.
          if (result.status === 200) {
            connectionsCache = { ts: now, result };
          }
        }
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gmail/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/gmail" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleGmailDisconnect } = await import("./connectors/gmail.js");
        const result = await handleGmailDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/gmail/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleGmailTest } = await import("./connectors/gmail.js");
        const result = await handleGmailTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── GitHub MCP connector routes ─────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/github/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/github/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleGithubTest } = await import("./connectors/github.js");
        const result = await handleGithubTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/github" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleGithubDisconnect } = await import(
          "./connectors/github.js"
        );
        const result = await handleGithubDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Sentry MCP connector routes ─────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/sentry/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  // OAuth callback for Sentry is registered in tryHandlePublicConnectorRoute
  // (pre-auth) — the IdP redirect arrives without a bearer token. Do NOT
  // re-register it here behind the auth gate (audit http-routes-3).
  if (
    parsedUrl.pathname === "/connections/sentry/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleSentryTest } = await import("./connectors/sentry.js");
        const result = await handleSentryTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/sentry" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleSentryDisconnect } = await import(
          "./connectors/sentry.js"
        );
        const result = await handleSentryDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Linear MCP connector routes ─────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/linear/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/linear/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleLinearCallback } = await import("./connectors/linear.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleLinearCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/linear/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleLinearTest } = await import("./connectors/linear.js");
        const result = await handleLinearTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/linear" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleLinearDisconnect } = await import(
          "./connectors/linear.js"
        );
        const result = await handleLinearDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Slack connector routes ──────────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/slack/auth" ||
      parsedUrl.pathname === "/connections/slack/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/slack/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleSlackTest } = await import("./connectors/slack.js");
        const result = await handleSlackTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/slack" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleSlackDisconnect } = await import("./connectors/slack.js");
        const result = await handleSlackDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Discord connector routes ───────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/discord/auth" ||
      parsedUrl.pathname === "/connections/discord/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  // OAuth callback for Discord is registered in tryHandlePublicConnectorRoute
  // (pre-auth) — the IdP redirect arrives without a bearer token. Do NOT
  // re-register it here behind the auth gate (audit http-routes-3).
  if (
    parsedUrl.pathname === "/connections/discord/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleDiscordTest } = await import("./connectors/discord.js");
        const result = await handleDiscordTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/discord" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleDiscordDisconnect } = await import(
          "./connectors/discord.js"
        );
        const result = await handleDiscordDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Asana connector routes ─────────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/asana/auth" ||
      parsedUrl.pathname === "/connections/asana/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/asana/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleAsanaCallback } = await import("./connectors/asana.js");
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        const error = parsedUrl.searchParams.get("error");
        const result = await handleAsanaCallback(code, state, error);
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "text/html",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/asana/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleAsanaTest } = await import("./connectors/asana.js");
        const result = await handleAsanaTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/asana" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleAsanaDisconnect } = await import("./connectors/asana.js");
        const result = await handleAsanaDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── GitLab connector routes ────────────────────────────────────
  if (
    (parsedUrl.pathname === "/connections/gitlab/auth" ||
      parsedUrl.pathname === "/connections/gitlab/authorize") &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleGitLabAuthorize } = await import(
          "./connectors/gitlab.js"
        );
        const result = handleGitLabAuthorize();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  // OAuth callback for GitLab is registered in tryHandlePublicConnectorRoute
  // (pre-auth) — the IdP redirect arrives without a bearer token. Do NOT
  // re-register it here behind the auth gate (audit http-routes-3).
  if (
    parsedUrl.pathname === "/connections/gitlab/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleGitLabTest } = await import("./connectors/gitlab.js");
        const result = await handleGitLabTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/gitlab" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleGitLabDisconnect } = await import(
          "./connectors/gitlab.js"
        );
        const result = await handleGitLabDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Notion routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/notion/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/notion.js");
      return m.handleNotionConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/notion/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleNotionTest } = await import("./connectors/notion.js");
        const result = await handleNotionTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/notion" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleNotionDisconnect } = await import(
          "./connectors/notion.js"
        );
        const result = handleNotionDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Confluence routes ───────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/confluence/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/confluence.js");
      return m.handleConfluenceConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/confluence/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleConfluenceTest } = await import(
          "./connectors/confluence.js"
        );
        const result = await handleConfluenceTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/confluence" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleConfluenceDisconnect } = await import(
          "./connectors/confluence.js"
        );
        const result = handleConfluenceDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Jira routes ─────────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/jira/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/jira.js");
      return m.handleJiraConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/jira/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleJiraTest } = await import("./connectors/jira.js");
        const result = await handleJiraTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/jira" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleJiraDisconnect } = await import("./connectors/jira.js");
        const result = handleJiraDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Zendesk routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/zendesk/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/zendesk.js");
      return m.handleZendeskConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/zendesk/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleZendeskTest } = await import("./connectors/zendesk.js");
        const result = await handleZendeskTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/zendesk" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleZendeskDisconnect } = await import(
          "./connectors/zendesk.js"
        );
        const result = handleZendeskDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Intercom routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/intercom/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/intercom.js");
      return m.handleIntercomConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/intercom/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleIntercomTest } = await import("./connectors/intercom.js");
        const result = await handleIntercomTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/intercom" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleIntercomDisconnect } = await import(
          "./connectors/intercom.js"
        );
        const result = handleIntercomDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── HubSpot routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/hubspot/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/hubspot.js");
      return m.handleHubSpotConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/hubspot/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleHubSpotTest } = await import("./connectors/hubspot.js");
        const result = await handleHubSpotTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/hubspot" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleHubSpotDisconnect } = await import(
          "./connectors/hubspot.js"
        );
        const result = handleHubSpotDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Datadog routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/datadog/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/datadog.js");
      return m.handleDatadogConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/datadog/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleDatadogTest } = await import("./connectors/datadog.js");
        const result = await handleDatadogTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/datadog" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleDatadogDisconnect } = await import(
          "./connectors/datadog.js"
        );
        const result = handleDatadogDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── PagerDuty routes ───────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/pagerduty/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/pagerduty.js");
      return m.handlePagerDutyConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/pagerduty/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handlePagerDutyTest } = await import(
          "./connectors/pagerduty.js"
        );
        const result = await handlePagerDutyTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/pagerduty" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handlePagerDutyDisconnect } = await import(
          "./connectors/pagerduty.js"
        );
        const result = handlePagerDutyDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Telegram routes ────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/telegram/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/telegram.js");
      return m.handleTelegramConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/telegram/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleTelegramTest } = await import("./connectors/telegram.js");
        const result = await handleTelegramTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/telegram" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleTelegramDisconnect } = await import(
          "./connectors/telegram.js"
        );
        const result = handleTelegramDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Stripe routes ───────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/stripe/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/stripe.js");
      return m.handleStripeConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/stripe/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleStripeTest } = await import("./connectors/stripe.js");
        const result = await handleStripeTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/stripe" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleStripeDisconnect } = await import(
          "./connectors/stripe.js"
        );
        const result = handleStripeDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Postgres routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/postgres/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/postgres.js");
      return m.handlePostgresConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/postgres/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handlePostgresTest } = await import("./connectors/postgres.js");
        const result = await handlePostgresTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/postgres" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handlePostgresDisconnect } = await import(
          "./connectors/postgres.js"
        );
        const result = await handlePostgresDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── MongoDB routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/mongodb/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/mongodb.js");
      return m.handleMongoConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/mongodb/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleMongoTest } = await import("./connectors/mongodb.js");
        const result = await handleMongoTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/mongodb" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleMongoDisconnect } = await import(
          "./connectors/mongodb.js"
        );
        const result = await handleMongoDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Redis routes ────────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/redis/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/redis.js");
      return m.handleRedisConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/redis/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleRedisTest } = await import("./connectors/redis.js");
        const result = await handleRedisTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/redis" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleRedisDisconnect } = await import("./connectors/redis.js");
        const result = await handleRedisDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Elasticsearch routes ────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/elasticsearch/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/elasticsearch.js");
      return m.handleElasticsearchConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/elasticsearch/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleElasticsearchTest } = await import(
          "./connectors/elasticsearch.js"
        );
        const result = await handleElasticsearchTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/elasticsearch" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleElasticsearchDisconnect } = await import(
          "./connectors/elasticsearch.js"
        );
        const result = await handleElasticsearchDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── SendGrid routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/sendgrid/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/sendgrid.js");
      return m.handleSendGridConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/sendgrid/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleSendGridTest } = await import("./connectors/sendgrid.js");
        const result = await handleSendGridTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/sendgrid" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleSendGridDisconnect } = await import(
          "./connectors/sendgrid.js"
        );
        const result = handleSendGridDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Twilio routes ───────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/twilio/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/twilio.js");
      return m.handleTwilioConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/twilio/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleTwilioTest } = await import("./connectors/twilio.js");
        const result = await handleTwilioTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/twilio" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleTwilioDisconnect } = await import(
          "./connectors/twilio.js"
        );
        const result = handleTwilioDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Figma routes ────────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/figma/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/figma.js");
      return m.handleFigmaConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/figma/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleFigmaTest } = await import("./connectors/figma.js");
        const result = await handleFigmaTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/figma" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleFigmaDisconnect } = await import("./connectors/figma.js");
        const result = handleFigmaDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Airtable routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/airtable/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/airtable.js");
      return m.handleAirtableConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/airtable/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleAirtableTest } = await import("./connectors/airtable.js");
        const result = await handleAirtableTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/airtable" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleAirtableDisconnect } = await import(
          "./connectors/airtable.js"
        );
        const result = handleAirtableDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Webflow routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/webflow/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/webflow.js");
      return m.handleWebflowConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/webflow/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleWebflowTest } = await import("./connectors/webflow.js");
        const result = await handleWebflowTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/webflow" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleWebflowDisconnect } = await import(
          "./connectors/webflow.js"
        );
        const result = handleWebflowDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Google Calendar routes ──────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/google-calendar/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleCalendarTest } = await import(
          "./connectors/googleCalendar.js"
        );
        const result = await handleCalendarTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-calendar" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleCalendarDisconnect } = await import(
          "./connectors/googleCalendar.js"
        );
        const result = await handleCalendarDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Google Drive routes ─────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/google-drive/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive/callback" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
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
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleDriveTest } = await import("./connectors/googleDrive.js");
        const result = await handleDriveTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-drive" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleDriveDisconnect } = await import(
          "./connectors/googleDrive.js"
        );
        const result = await handleDriveDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Google Docs routes ──────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/google-docs/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleDocsAuthRedirect } = await import(
          "./connectors/googleDocs.js"
        );
        const result = handleDocsAuthRedirect();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-docs/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleDocsTest } = await import("./connectors/googleDocs.js");
        const result = await handleDocsTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/google-docs" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleDocsDisconnect } = await import(
          "./connectors/googleDocs.js"
        );
        const result = await handleDocsDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Monday routes ───────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/monday/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleMondayAuthRedirect } = await import(
          "./connectors/monday.js"
        );
        const result = handleMondayAuthRedirect();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/monday/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleMondayTest } = await import("./connectors/monday.js");
        const result = await handleMondayTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/monday" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleMondayDisconnect } = await import(
          "./connectors/monday.js"
        );
        const result = await handleMondayDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Salesforce routes ───────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/salesforce/auth" &&
    req.method === "GET"
  ) {
    void (async () => {
      try {
        const { handleSalesforceAuthRedirect } = await import(
          "./connectors/salesforce.js"
        );
        const result = handleSalesforceAuthRedirect();
        if (result.redirect) {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else {
          res.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
          });
          res.end(result.body);
        }
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/salesforce/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleSalesforceTest } = await import(
          "./connectors/salesforce.js"
        );
        const result = await handleSalesforceTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/salesforce" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleSalesforceDisconnect } = await import(
          "./connectors/salesforce.js"
        );
        const result = await handleSalesforceDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Shopify routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/shopify/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/shopify.js");
      return m.handleShopifyConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/shopify/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleShopifyTest } = await import("./connectors/shopify.js");
        const result = await handleShopifyTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/shopify" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleShopifyDisconnect } = await import(
          "./connectors/shopify.js"
        );
        const result = await handleShopifyDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Snowflake routes ────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/snowflake/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/snowflake.js");
      return m.handleSnowflakeConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/snowflake/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleSnowflakeTest } = await import(
          "./connectors/snowflake.js"
        );
        const result = await handleSnowflakeTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/snowflake" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleSnowflakeDisconnect } = await import(
          "./connectors/snowflake.js"
        );
        const result = await handleSnowflakeDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Resend routes ───────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/resend/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/resend.js");
      return m.handleResendConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/resend/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleResendTest } = await import("./connectors/resend.js");
        const result = await handleResendTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/resend" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleResendDisconnect } = await import(
          "./connectors/resend.js"
        );
        const result = handleResendDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Obsidian routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/obsidian/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/obsidian.js");
      return m.handleObsidianConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/obsidian/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleObsidianTest } = await import("./connectors/obsidian.js");
        const result = await handleObsidianTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/obsidian" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleObsidianDisconnect } = await import(
          "./connectors/obsidian.js"
        );
        const result = handleObsidianDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Todoist routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/todoist/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/todoist.js");
      return m.handleTodoistConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/todoist/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleTodoistTest } = await import("./connectors/todoist.js");
        const result = await handleTodoistTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/todoist" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleTodoistDisconnect } = await import(
          "./connectors/todoist.js"
        );
        const result = handleTodoistDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Vercel routes ───────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/vercel/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/vercel.js");
      return m.handleVercelConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/vercel/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleVercelTest } = await import("./connectors/vercel.js");
        const result = await handleVercelTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/vercel" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleVercelDisconnect } = await import(
          "./connectors/vercel.js"
        );
        const result = handleVercelDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Paystack routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/paystack/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/paystack.js");
      return m.handlePaystackConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/paystack/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handlePaystackTest } = await import("./connectors/paystack.js");
        const result = await handlePaystackTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/paystack" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handlePaystackDisconnect } = await import(
          "./connectors/paystack.js"
        );
        const result = handlePaystackDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Pipedrive routes ────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/pipedrive/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/pipedrive.js");
      return m.handlePipedriveConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/pipedrive/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handlePipedriveTest } = await import(
          "./connectors/pipedrive.js"
        );
        const result = await handlePipedriveTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/pipedrive" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handlePipedriveDisconnect } = await import(
          "./connectors/pipedrive.js"
        );
        const result = handlePipedriveDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Cal.diy routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/caldiy/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/caldiy.js");
      return m.handleCalDiyConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/caldiy/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleCalDiyTest } = await import("./connectors/caldiy.js");
        const result = await handleCalDiyTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (parsedUrl.pathname === "/connections/caldiy" && req.method === "DELETE") {
    void (async () => {
      try {
        const { handleCalDiyDisconnect } = await import(
          "./connectors/caldiy.js"
        );
        const result = handleCalDiyDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Grafana routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/grafana/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/grafana.js");
      return m.handleGrafanaConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/grafana/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleGrafanaTest } = await import("./connectors/grafana.js");
        const result = await handleGrafanaTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/grafana" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleGrafanaDisconnect } = await import(
          "./connectors/grafana.js"
        );
        const result = handleGrafanaDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── PostHog routes ──────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/posthog/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/posthog.js");
      return m.handlePostHogConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/posthog/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handlePostHogTest } = await import("./connectors/posthog.js");
        const result = await handlePostHogTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/posthog" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handlePostHogDisconnect } = await import(
          "./connectors/posthog.js"
        );
        const result = handlePostHogDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Cloudflare routes ───────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/cloudflare/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/cloudflare.js");
      return m.handleCloudflareConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/cloudflare/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleCloudflareTest } = await import(
          "./connectors/cloudflare.js"
        );
        const result = await handleCloudflareTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/cloudflare" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleCloudflareDisconnect } = await import(
          "./connectors/cloudflare.js"
        );
        const result = handleCloudflareDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── CircleCI routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/circleci/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/circleci.js");
      return m.handleCircleCIConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/circleci/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleCircleCITest } = await import("./connectors/circleci.js");
        const result = await handleCircleCITest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/circleci" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleCircleCIDisconnect } = await import(
          "./connectors/circleci.js"
        );
        const result = handleCircleCIDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── WooCommerce routes ──────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/woocommerce/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/woocommerce.js");
      return m.handleWooCommerceConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/woocommerce/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleWooCommerceTest } = await import(
          "./connectors/woocommerce.js"
        );
        const result = await handleWooCommerceTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/woocommerce" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleWooCommerceDisconnect } = await import(
          "./connectors/woocommerce.js"
        );
        const result = handleWooCommerceDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  // ── Supabase routes ─────────────────────────────────────────────
  if (
    parsedUrl.pathname === "/connections/supabase/connect" &&
    req.method === "POST"
  ) {
    void dispatchConnectorConnect(req, res, async () => {
      const m = await import("./connectors/supabase.js");
      return m.handleSupabaseConnect;
    });
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/supabase/test" &&
    req.method === "POST"
  ) {
    void (async () => {
      try {
        const { handleSupabaseTest } = await import("./connectors/supabase.js");
        const result = await handleSupabaseTest();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }
  if (
    parsedUrl.pathname === "/connections/supabase" &&
    req.method === "DELETE"
  ) {
    void (async () => {
      try {
        const { handleSupabaseDisconnect } = await import(
          "./connectors/supabase.js"
        );
        const result = handleSupabaseDisconnect();
        res.writeHead(result.status, {
          "Content-Type": result.contentType ?? "application/json",
        });
        res.end(result.body);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  return false;
}
