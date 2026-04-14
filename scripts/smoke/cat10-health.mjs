/**
 * Category 10 — Health & circuit breaker endpoints.
 * Usage: node cat10-health.mjs <port> <token>
 */
import {
  assert,
  assertEq,
  httpGet,
  mcpHandshake,
  sleep,
  summary,
  wsSend,
} from "./helpers.mjs";

const port = Number(process.argv[2]);
const token = process.argv[3];
if (!port || !token) {
  console.error("Usage: cat10-health.mjs <port> <token>");
  process.exit(1);
}

const BASE = `http://127.0.0.1:${port}`;
const AUTH_HDR = { Authorization: `Bearer ${token}` };
console.log("\n[CAT-10] Health endpoints");

// Brief pause — cat8 may have saturated the WS connection throttle
await sleep(600);

// 10.1 GET /health → 200 + required fields
{
  const r = await httpGet(`${BASE}/health`, AUTH_HDR);
  assertEq(r.status, 200, "10.1 /health → 200");
  try {
    const d = JSON.parse(r.body);
    assert("uptime" in d || "uptimeMs" in d, "10.1 /health has uptime field");
    assert(
      "version" in d || "bridgeVersion" in d || "status" in d,
      "10.1 /health has version or status field",
    );
  } catch {
    assert(false, "10.1 /health body not valid JSON");
  }
}

// 10.2 GET /ready → 200 + ready:true + toolCount > 0
{
  const r = await httpGet(`${BASE}/ready`, AUTH_HDR);
  assertEq(r.status, 200, "10.2 /ready → 200");
  try {
    const d = JSON.parse(r.body);
    assertEq(d.ready, true, "10.2 /ready.ready === true");
    assert(
      typeof d.toolCount === "number" && d.toolCount > 0,
      `10.2 /ready.toolCount > 0 (got ${d.toolCount})`,
    );
  } catch {
    assert(false, "10.2 /ready body not valid JSON");
  }
}

// 10.3 GET /status → required fields (may not exist on all versions)
{
  const r = await httpGet(`${BASE}/status`, AUTH_HDR);
  if (r.status === 200) {
    try {
      const d = JSON.parse(r.body);
      assert(
        "version" in d || "uptime" in d || "uptimeMs" in d,
        "10.3 /status has version or uptime",
      );
    } catch {
      assert(false, "10.3 /status body not valid JSON");
    }
    assert(true, "10.3 /status → 200");
  } else {
    // /status may not exist in slim mode — acceptable
    assert(r.status === 404, `10.3 /status → 200 or 404 (got ${r.status})`);
  }
}

// 10.4 getBridgeStatus tool → structured response
{
  const ws = await mcpHandshake(port, token);
  const resp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: { name: "getBridgeStatus", arguments: {} },
  });
  assert(
    !resp.error,
    `10.4 getBridgeStatus no JSON-RPC error (got ${JSON.stringify(resp.error)})`,
  );
  const text =
    resp.result?.content?.[0]?.text ?? resp.result?.structuredContent ?? "";
  const str = typeof text === "string" ? text : JSON.stringify(text);
  assert(
    str.includes("version") ||
      str.includes("toolCount") ||
      str.includes("extensionConnected"),
    "10.4 getBridgeStatus contains version/toolCount/extensionConnected",
  );
  ws.close();
}

// 10.5 GET /dashboard → 200 text/html (unauthenticated)
{
  const r = await httpGet(`${BASE}/dashboard`);
  assertEq(r.status, 200, "10.5 /dashboard → 200");
  assert(
    (r.headers?.["content-type"] ?? "").includes("text/html"),
    "10.5 /dashboard content-type: text/html",
  );
  assert(
    r.body.includes("Claude IDE Bridge"),
    "10.5 /dashboard body contains title",
  );
}

// 10.6 GET /dashboard/data → 200 JSON with version + uptimeMs
{
  const r = await httpGet(`${BASE}/dashboard/data`);
  assertEq(r.status, 200, "10.6 /dashboard/data → 200");
  try {
    const d = JSON.parse(r.body);
    assert(typeof d.version === "string", "10.6 /dashboard/data has version");
    assert(typeof d.uptimeMs === "number", "10.6 /dashboard/data has uptimeMs");
  } catch {
    assert(false, "10.6 /dashboard/data body not valid JSON");
  }
}

summary("CAT-10");
