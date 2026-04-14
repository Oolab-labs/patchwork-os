/**
 * Category 3 — WebSocket auth & security.
 * Usage: node cat3-auth.mjs <port> <token>
 */
import {
  assert,
  mcpHandshake,
  sleep,
  summary,
  wsConnect,
  wsSend,
} from "./helpers.mjs";

const port = Number(process.argv[2]);
const token = process.argv[3];
if (!port || !token) {
  console.error("Usage: cat3-auth.mjs <port> <token>");
  process.exit(1);
}

console.log("\n[CAT-3] WebSocket auth & security");

// 3.1 Valid token accepted
try {
  const ws = await wsConnect(port, token);
  ws.close();
  assert(true, "3.1 valid token → connection opens");
} catch (e) {
  assert(false, `3.1 valid token → connection opens (${e.message})`);
}

// 3.2 Wrong token rejected with 401
try {
  await wsConnect(port, "wrongtoken_x".padEnd(64, "0"));
  assert(false, "3.2 wrong token → 401 (connection opened unexpectedly)");
} catch (e) {
  assert(
    e.statusCode === 401,
    `3.2 wrong token → 401 (got ${e.statusCode ?? e.message})`,
  );
}

// 3.3 Missing auth header rejected with 401
try {
  await wsConnect(port, "");
  assert(false, "3.3 missing token → 401 (connection opened unexpectedly)");
} catch (e) {
  assert(
    e.statusCode === 401,
    `3.3 missing token → 401 (got ${e.statusCode ?? e.message})`,
  );
}

// 3.4 DNS rebinding defense — non-loopback Host header rejected
try {
  await wsConnect(port, token, { host: "evil.attacker.com" });
  assert(false, "3.4 bad Host header → 403 (connection opened unexpectedly)");
} catch (e) {
  assert(
    e.statusCode === 403,
    `3.4 bad Host header → 403 (got ${e.statusCode ?? e.message})`,
  );
}

// 3.5 MCP handshake — serverInfo present
// Wait for connection throttle (MIN_CONNECTION_INTERVAL_MS=500) to clear after rapid auth tests
await sleep(600);
try {
  const ws = await mcpHandshake(port, token);
  const resp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: 99,
    method: "tools/list",
    params: {},
  });
  assert(
    Array.isArray(resp.result?.tools),
    "3.5 MCP handshake → tools/list returns array",
  );
  ws.close();
} catch (e) {
  assert(false, `3.5 MCP handshake (${e.message})`);
}

summary("CAT-3");
