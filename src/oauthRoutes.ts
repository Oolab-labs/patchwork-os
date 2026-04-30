/**
 * OAuth 2.0 route dispatcher — extracted from src/server.ts.
 *
 * Owns the public OAuth endpoints (RFC 8414 discovery, RFC 9396 protected-
 * resource metadata, RFC 7591 dynamic client registration, authorize,
 * token, RFC 7009 revoke). All routes are unauthenticated — they MUST
 * run before the bearer-auth gate.
 *
 * DI shape: handlers depend on a nullable `OAuthServer` member object and
 * an issuer URL. Both are assigned post-construction via `setOAuthServer`
 * on the bridge Server, so `tryHandleOAuthRoute` accepts them as a deps
 * argument (vs. closing over `this`). When OAuth isn't configured, every
 * route falls through to 404 (or 200 for `/oauth/revoke` per RFC 7009).
 *
 * Mechanical-equivalent lift: handler bodies are identical to the
 * originals save for `deps.oauthServer` replacing `this.oauthServer` and
 * `deps.oauthIssuerUrl` replacing `this.oauthIssuerUrl`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OAuthServer } from "./oauth.js";

export interface OAuthRouteDeps {
  oauthServer: OAuthServer | null;
  oauthIssuerUrl: string | null;
}

/**
 * Try to handle a `/.well-known/oauth-*` or `/oauth/*` route. Returns
 * true if the route was dispatched (caller should `return` from the
 * request handler), false if no route matched.
 *
 * MUST be called before the bearer-auth gate.
 */
export function tryHandleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  deps: OAuthRouteDeps,
): boolean {
  // RFC 8414 discovery document
  if (
    parsedUrl.pathname === "/.well-known/oauth-authorization-server" &&
    req.method === "GET"
  ) {
    if (deps.oauthServer) {
      deps.oauthServer.handleDiscovery(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("OAuth not configured");
    }
    return true;
  }

  // RFC 9396 Protected Resource Metadata — Claude.ai probes this to discover
  // which authorization server protects this resource. Both the bare and
  // resource-path variants are handled.
  if (
    req.method === "GET" &&
    (parsedUrl.pathname === "/.well-known/oauth-protected-resource" ||
      parsedUrl.pathname.startsWith("/.well-known/oauth-protected-resource/"))
  ) {
    if (deps.oauthServer && deps.oauthIssuerUrl) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          resource: deps.oauthIssuerUrl,
          authorization_servers: [deps.oauthIssuerUrl],
        }),
      );
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("OAuth not configured");
    }
    return true;
  }

  // Authorization endpoint
  if (
    parsedUrl.pathname === "/oauth/authorize" &&
    (req.method === "GET" || req.method === "POST")
  ) {
    if (deps.oauthServer) {
      deps.oauthServer.handleAuthorize(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("OAuth not configured");
    }
    return true;
  }

  // Dynamic Client Registration endpoint (RFC 7591)
  if (parsedUrl.pathname === "/oauth/register") {
    if (deps.oauthServer) {
      deps.oauthServer.handleRegister(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("OAuth not configured");
    }
    return true;
  }

  // Token endpoint
  if (parsedUrl.pathname === "/oauth/token" && req.method === "POST") {
    if (deps.oauthServer) {
      deps.oauthServer.handleToken(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("OAuth not configured");
    }
    return true;
  }

  // Revocation endpoint (RFC 7009)
  if (parsedUrl.pathname === "/oauth/revoke" && req.method === "POST") {
    if (deps.oauthServer) {
      deps.oauthServer.handleRevoke(req, res).catch(() => {
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
    return true;
  }

  return false;
}
