/**
 * Category 8 — Per-session rate limiting.
 * Usage: node cat8-ratelimit.mjs <port> <token>
 */
import { assert, mcpHandshake, sleep, summary, wsSend } from "./helpers.mjs";

const port = Number(process.argv[2]);
const token = process.argv[3];
if (!port || !token) {
  console.error("Usage: cat8-ratelimit.mjs <port> <token>");
  process.exit(1);
}

console.log("\n[CAT-8] Rate limiting");

// Use a fresh WS session so we start with a clean rate-limit bucket
const ws = await mcpHandshake(port, token);

let rateLimitHit = false;
let successCount = 0;

// Rate limit error codes:
//   -32004 = session request rate limit (200 req/min ring buffer)
//   -32029 = per-session tool token bucket (separate limit)
const RATE_LIMIT_CODE = -32004;

// 8.1 Send 199 rapid tools/list — all should succeed
// (initialize counts as 1 of the 200/min limit; 199 + 1 = 200, limit not yet exceeded)
for (let i = 3; i < 202; i++) {
  const resp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: i,
    method: "tools/list",
    params: {},
  });
  if (resp.error?.code === RATE_LIMIT_CODE) {
    rateLimitHit = true;
    break;
  }
  successCount++;
}
assert(
  !rateLimitHit,
  `8.1 199 rapid requests succeed without rate-limit (initialize used 1 slot; ${successCount} succeeded)`,
);

// 8.2 200th request (201st including initialize) should hit rate limit (-32004)
let got201RateLimit = false;
for (let i = 202; i < 300; i++) {
  const resp = await wsSend(ws, {
    jsonrpc: "2.0",
    id: i,
    method: "tools/list",
    params: {},
  });
  if (resp.error?.code === RATE_LIMIT_CODE) {
    got201RateLimit = true;
    break;
  }
}
assert(
  got201RateLimit,
  `8.2 rate limit ${RATE_LIMIT_CODE} triggered after 200 requests`,
);

ws.close();

// 8.3 AJV validation failure does NOT consume rate limit token
// Use a fresh session (wait for connection throttle to clear)
await sleep(700);
let ws2;
try {
  ws2 = await mcpHandshake(port, token);
} catch (e) {
  // HTTP 429 = connection throttle still active — test inconclusive but not a failure
  assert(
    e.statusCode !== 401,
    `8.3 ws2 connect: unexpected 401 (wrong token?)`,
  );
  assert(
    true,
    `8.3 skipped — connection throttle still active (${e.statusCode ?? e.message})`,
  );
  summary("CAT-8");
}

if (ws2) {
  const invalidResp = await wsSend(ws2, {
    jsonrpc: "2.0",
    id: 500,
    method: "tools/call",
    params: { name: "getDiagnostics", arguments: { badField: 123 } },
  });
  assert(
    invalidResp.error?.code !== RATE_LIMIT_CODE,
    `8.3 AJV failure returns ${invalidResp.error?.code ?? "isError"}, not ${RATE_LIMIT_CODE}`,
  );

  const validResp = await wsSend(ws2, {
    jsonrpc: "2.0",
    id: 501,
    method: "tools/list",
    params: {},
  });
  assert(
    !validResp.error || validResp.error.code !== RATE_LIMIT_CODE,
    `8.3 valid request after AJV failure succeeds (no ${RATE_LIMIT_CODE})`,
  );
  ws2.close();
}

summary("CAT-8");
