/**
 * MCP server-card + CORS preflight dispatcher — extracted from
 * src/server.ts.
 *
 * Owns two unauthenticated routes that must run BEFORE the bearer-auth
 * gate:
 *
 *   - GET /.well-known/mcp/server-card.json (and /.well-known/mcp alias)
 *     The public discovery card. Claude.ai probes this before connecting
 *     to learn capabilities and transports. Always returns 200 + JSON
 *     with `Access-Control-Allow-Origin: *` (intentional — discovery is
 *     public; no secrets).
 *
 *   - OPTIONS /mcp
 *     CORS preflight. Browsers (and Claude Desktop's web renderer) send
 *     this before POSTing. Origin validation goes through `corsOrigin()`
 *     which reflects loopback origins by default and any extra origins
 *     passed via --cors-origin. UNTRUSTED ORIGINS GET NO Access-Control-
 *     Allow-Origin HEADER — that's the gate that prevents CORS escape.
 *
 * DI shape: only the CORS-preflight handler needs `extraCorsOrigins`
 * (the --cors-origin allowlist). Server.ts passes it as a deps struct
 * matching the pattern established in oauthRoutes.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { corsOrigin } from "./cors.js";
import { BRIDGE_PROTOCOL_VERSION, PACKAGE_LICENSE } from "./version.js";

export interface McpRouteDeps {
  /** Extra trusted origins from --cors-origin / CLAUDE_IDE_BRIDGE_CORS_ORIGINS. */
  extraCorsOrigins: string[];
}

/**
 * Try to handle the MCP server-card discovery routes or the /mcp CORS
 * preflight. Returns true if the route was dispatched (caller should
 * `return` from the request handler), false otherwise.
 *
 * MUST be called before the bearer-auth gate.
 */
export function tryHandleMcpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  deps: McpRouteDeps,
): boolean {
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
    return true;
  }

  // CORS preflight for /mcp — browsers (and Claude Desktop's web renderer) send
  // OPTIONS before POST. Respond without requiring auth so the preflight succeeds.
  if (req.method === "OPTIONS" && parsedUrl.pathname === "/mcp") {
    const origin = corsOrigin(req.headers.origin, deps.extraCorsOrigins);
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
    return true;
  }

  return false;
}
