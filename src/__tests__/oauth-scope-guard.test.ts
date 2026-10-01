/**
 * Guard: the OAuth server must not advertise a scope narrower than `mcp`
 * until the HTTP bearer gate learns to enforce scopes.
 *
 * Why this exists (security sweep 2026-10-01, L9). The bearer gate in
 * `src/server.ts` resolves an OAuth access token to "the bridge token" and
 * admits it to EVERY bearer-gated route — `/shutdown`, `/kill-switch`,
 * `/settings`, `/approvals`, recipe install — without looking at the token's
 * scope. Scope is enforced in exactly one place, `src/transport.ts`, and only
 * inside MCP `tools/call` (an `mcp:read` session may call read-only tools).
 *
 * That is harmless today for one reason: `SUPPORTED_SCOPES` is `["mcp"]`, so
 * no token with a narrower scope can be issued, and the transport's
 * `mcp:read` branch is unreachable. The moment a narrower scope is added —
 * an obviously reasonable feature — a "read-only" token becomes a full
 * administrative credential over HTTP, and nothing in the test suite would
 * notice: no test referenced `mcp:read` before this one.
 *
 * So this test pins the ADVERTISED surface (RFC 8414 `scopes_supported`,
 * which is what a client reads) to exactly `["mcp"]`. If you are here because
 * it failed: do not widen the expectation. First make the bearer gate in
 * `server.ts` consult the resolved token's scope on non-MCP routes (deny
 * anything but full `mcp` scope on mutating routes), add a test that proves
 * an `mcp:read` token is refused on `/kill-switch` and `/settings`, and then
 * add the scope here.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { OAuthServerImpl } from "../oauth.js";

class MockResponse {
  statusCode = 200;
  body = "";
  writeHead(status: number) {
    this.statusCode = status;
    return this;
  }
  setHeader() {}
  end(body?: string) {
    this.body = body ?? "";
    return this;
  }
}

describe("OAuth scope surface — guard against a narrower scope the HTTP gate cannot enforce", () => {
  it("advertises exactly ['mcp'] in scopes_supported", () => {
    const oauth = new OAuthServerImpl(
      crypto.randomBytes(32).toString("hex"),
      "https://bridge.example.test",
    );
    const res = new MockResponse();
    oauth.handleDiscovery(res as unknown as http.ServerResponse);
    oauth.destroy();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { scopes_supported?: unknown };
    expect(
      body.scopes_supported,
      "A scope narrower than `mcp` was added. The HTTP bearer gate (src/server.ts) " +
        "does not enforce scopes on non-MCP routes, so such a token is a full " +
        "credential over /kill-switch, /settings, /shutdown and /approvals. " +
        "Fix the gate and prove it with a test before widening this list — " +
        "see the header of this file.",
    ).toEqual(["mcp"]);
  });

  it("refuses to register a client asking for a scope it does not support (the other half of the surface)", async () => {
    const oauth = new OAuthServerImpl(
      crypto.randomBytes(32).toString("hex"),
      "https://bridge.example.test",
    );
    const { Readable } = await import("node:stream");
    const body = JSON.stringify({
      redirect_uris: ["https://app.example.test/cb"],
      scope: "mcp:read",
    });
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      method: "POST",
      headers: { "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as http.IncomingMessage;
    const res = new MockResponse();
    await oauth.handleRegister(req, res as unknown as http.ServerResponse);
    oauth.destroy();
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("unsupported scope");
  });
});
