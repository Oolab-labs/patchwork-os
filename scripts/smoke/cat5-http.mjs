/**
 * Category 5 — Streamable HTTP transport.
 * Usage: node cat5-http.mjs <port> <token>
 */
import http from "node:http";
import { assert, assertEq, httpDelete, httpPost, summary } from "./helpers.mjs";

const port = Number(process.argv[2]);
const token = process.argv[3];
if (!port || !token) {
  console.error("Usage: cat5-http.mjs <port> <token>");
  process.exit(1);
}

const BASE = `http://127.0.0.1:${port}`;
const AUTH = { Authorization: `Bearer ${token}` };
const CT_JSON = {
  "Content-Type": "application/json",
  Accept: "application/json",
};
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  },
};

console.log("\n[CAT-5] Streamable HTTP transport");

// 5.1 POST /mcp initialize → 200 + session header
let sessionId;
{
  const r = await httpPost(`${BASE}/mcp`, INIT, { ...AUTH, ...CT_JSON });
  assertEq(r.status, 200, "5.1 initialize → 200");
  sessionId = r.headers["mcp-session-id"];
  assert(
    typeof sessionId === "string" && sessionId.length > 0,
    "5.1 Mcp-Session-Id header set",
  );
}

// Send notifications/initialized (required by MCP protocol before other requests)
await httpPost(
  `${BASE}/mcp`,
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { ...AUTH, ...CT_JSON, "Mcp-Session-Id": sessionId },
);

// 5.2 Reuse session — tools/list
{
  const r = await httpPost(
    `${BASE}/mcp`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { ...AUTH, ...CT_JSON, "Mcp-Session-Id": sessionId },
  );
  assertEq(r.status, 200, "5.2 session reuse → 200");
  const body = JSON.parse(r.body);
  assert(Array.isArray(body.result?.tools), "5.2 tools/list returns array");
}

// 5.3 GET /mcp → SSE stream headers
{
  // Just check response headers — don't consume the stream
  const r = await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "GET",
        headers: {
          ...AUTH,
          Accept: "text/event-stream",
          "Mcp-Session-Id": sessionId,
        },
      },
      (res) => {
        resolve({ status: res.statusCode, ct: res.headers["content-type"] });
        res.destroy();
      },
    );
    req.on("error", () => resolve({ status: 0, ct: "" }));
    req.end();
  });
  assertEq(r.status, 200, "5.3 GET /mcp → 200");
  assert(
    r.ct?.includes("text/event-stream"),
    `5.3 Content-Type: text/event-stream (got ${r.ct})`,
  );
}

// 5.4 DELETE /mcp → 200 or 204
{
  const r = await httpDelete(`${BASE}/mcp`, {
    ...AUTH,
    "Mcp-Session-Id": sessionId,
  });
  assert(
    r.status === 200 || r.status === 204,
    `5.4 DELETE /mcp → 200/204 (got ${r.status})`,
  );
}

// 5.5 Deleted session rejected on reuse → 404
{
  const r = await httpPost(
    `${BASE}/mcp`,
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { ...AUTH, ...CT_JSON, "Mcp-Session-Id": sessionId },
  );
  assertEq(r.status, 404, `5.5 deleted session → 404 (got ${r.status})`);
}

// 5.6 Session cap — open 5 sessions, request 6th
{
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const r = await httpPost(`${BASE}/mcp`, INIT, { ...AUTH, ...CT_JSON });
    if (r.status === 200) sessions.push(r.headers["mcp-session-id"]);
  }
  // 6th session: either 200 (oldest idle evicted) or 503
  const r6 = await httpPost(`${BASE}/mcp`, INIT, { ...AUTH, ...CT_JSON });
  assert(
    r6.status === 200 || r6.status === 503,
    `5.6 6th session → 200 (eviction) or 503 (no idle) (got ${r6.status})`,
  );
  // Cleanup
  for (const sid of sessions) {
    await httpDelete(`${BASE}/mcp`, { ...AUTH, "Mcp-Session-Id": sid }).catch(
      () => {},
    );
  }
}

// 5.7 Unauthenticated POST → 401
{
  const r = await httpPost(`${BASE}/mcp`, INIT, CT_JSON);
  assertEq(r.status, 401, `5.7 unauthenticated → 401 (got ${r.status})`);
}

summary("CAT-5");
