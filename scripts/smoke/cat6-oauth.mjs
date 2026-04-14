/**
 * Category 6 — OAuth 2.0 (PKCE flow).
 *
 * 6.1  /.well-known/oauth-authorization-server returns RFC 8414 metadata
 * 6.2  /oauth/register (RFC 7591 dynamic registration) returns client_id
 * 6.3  GET /oauth/authorize returns HTML form with CSRF nonce
 * 6.4  POST /oauth/authorize (approve) issues authorization code
 * 6.5  POST /oauth/token exchanges code+verifier for access_token
 * 6.6  Access token authorizes MCP WS request
 * 6.7  POST /oauth/revoke invalidates token (MCP WS rejects afterward)
 *
 * Spawns its own isolated bridge with --issuer-url so main bridge is unaffected.
 * Usage: node cat6-oauth.mjs
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { assert, sleep, summary, waitForBridge } from "./helpers.mjs";

const BRIDGE = process.env.BRIDGE ?? "claude-ide-bridge";
const PORT = 37261;
const ISSUER = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = "http://localhost:9999/callback";
// Must be a valid UUID — bridge rejects non-UUID fixed tokens
const BRIDGE_TOKEN = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const ENV = {
  ...process.env,
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "smoke-oauth-cfg-")),
};
fs.mkdirSync(path.join(ENV.CLAUDE_CONFIG_DIR, "ide"), { recursive: true });
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-oauth-ws-"));

console.log("\n[CAT-6] OAuth 2.0 PKCE flow");

const proc = spawn(
  BRIDGE,
  [
    "--port",
    String(PORT),
    "--workspace",
    workspace,
    "--issuer-url",
    ISSUER,
    "--fixed-token",
    BRIDGE_TOKEN,
  ],
  { env: ENV, stdio: "ignore", detached: false },
);

// ── Helpers ────────────────────────────────────────────────────────────────────

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function makeVerifier() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
  });
}

async function httpPostForm(url, params, headers = {}) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (d) => {
        data += d;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data }),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function httpPostJson(url, json, headers = {}) {
  const body = JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (d) => {
        data += d;
      });
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

try {
  await waitForBridge(PORT, 10_000, ENV.CLAUDE_CONFIG_DIR);

  // ── 6.1 Discovery ─────────────────────────────────────────────────────────────
  const discResp = await httpGet(
    `${ISSUER}/.well-known/oauth-authorization-server`,
  );
  assert(discResp.status === 200, "6.1 discovery endpoint returns 200");
  let discBody;
  try {
    discBody = JSON.parse(discResp.body);
  } catch {
    discBody = {};
  }
  assert(
    discBody.issuer === ISSUER &&
      typeof discBody.authorization_endpoint === "string" &&
      typeof discBody.token_endpoint === "string" &&
      typeof discBody.registration_endpoint === "string",
    "6.1 discovery includes issuer, authorization_endpoint, token_endpoint, registration_endpoint",
  );

  // ── 6.2 Dynamic registration ──────────────────────────────────────────────────
  const regResp = await httpPostJson(`${ISSUER}/oauth/register`, {
    client_name: "smoke-test-client",
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
  assert(
    regResp.status === 201,
    `6.2 /oauth/register returns 201 (got ${regResp.status})`,
  );
  const clientId = regResp.body?.client_id;
  assert(
    typeof clientId === "string" && clientId.length > 0,
    "6.2 registration returns client_id",
  );

  // ── 6.3 GET /oauth/authorize — prime CSRF nonce ────────────────────────────────
  const { verifier, challenge } = makeVerifier();
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    state: "state123",
  });
  const getAuthResp = await httpGet(`${ISSUER}/oauth/authorize?${authParams}`);
  assert(
    getAuthResp.status === 200,
    `6.3 GET /oauth/authorize returns 200 (got ${getAuthResp.status})`,
  );
  // Extract csrf_nonce and flow_id from hidden inputs in HTML
  const nonceMatch = getAuthResp.body.match(
    /name="csrf_nonce"\s+value="([^"]+)"/,
  );
  const flowIdMatch = getAuthResp.body.match(
    /name="flow_id"\s+value="([^"]+)"/,
  );
  assert(nonceMatch != null, "6.3 HTML form contains csrf_nonce hidden input");
  assert(flowIdMatch != null, "6.3 HTML form contains flow_id hidden input");
  const csrfNonce = nonceMatch[1];
  const flowId = flowIdMatch[1];

  // ── 6.4 POST /oauth/authorize (approve) → redirect with code ──────────────────
  const postAuthResp = await httpPostForm(`${ISSUER}/oauth/authorize`, {
    action: "approve",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    bridge_token: BRIDGE_TOKEN,
    scope: "mcp",
    state: "state123",
    csrf_nonce: csrfNonce,
    flow_id: flowId,
  });
  assert(
    postAuthResp.status === 302,
    `6.4 POST /oauth/authorize returns 302 redirect (got ${postAuthResp.status})`,
  );
  const location = postAuthResp.headers.location ?? "";
  const redirectUrl = new URL(
    location.startsWith("http") ? location : `http://localhost${location}`,
  );
  const authCode = redirectUrl.searchParams.get("code");
  assert(
    typeof authCode === "string" && authCode.length > 0,
    "6.4 redirect location contains authorization code",
  );

  // ── 6.5 POST /oauth/token — exchange code for access_token ────────────────────
  const tokenResp = await httpPostForm(`${ISSUER}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code: authCode,
    code_verifier: verifier,
  });
  assert(
    tokenResp.status === 200,
    `6.5 /oauth/token returns 200 (got ${tokenResp.status})`,
  );
  let tokenBody;
  try {
    tokenBody = JSON.parse(tokenResp.body);
  } catch {
    tokenBody = {};
  }
  const accessToken = tokenBody.access_token;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "6.5 token response contains access_token",
  );
  assert(tokenBody.token_type === "Bearer", "6.5 token_type is Bearer");

  // ── 6.6 Access token authorizes MCP via Streamable HTTP ──────────────────────
  // OAuth access tokens are for HTTP transport (Authorization: Bearer), not WS.
  const CT_JSON = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const BEARER = { Authorization: `Bearer ${accessToken}` };
  const initResp = await httpPostJson(
    `${ISSUER}/mcp`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-cat6", version: "1.0" },
      },
    },
    { ...CT_JSON, ...BEARER },
  );
  assert(
    initResp.status === 200,
    `6.6 OAuth access token authorizes HTTP MCP initialize (got ${initResp.status})`,
  );
  const sessionId = initResp.headers["mcp-session-id"];
  assert(
    typeof sessionId === "string",
    "6.6 initialize returns Mcp-Session-Id",
  );
  // Send notifications/initialized then tools/list
  await httpPostJson(
    `${ISSUER}/mcp`,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { ...CT_JSON, ...BEARER, "Mcp-Session-Id": sessionId },
  );
  const toolsHttpResp = await httpPostJson(
    `${ISSUER}/mcp`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { ...CT_JSON, ...BEARER, "Mcp-Session-Id": sessionId },
  );
  assert(
    Array.isArray(toolsHttpResp.body?.result?.tools),
    "6.6 tools/list via OAuth HTTP session returns tools array",
  );

  // ── 6.7 Revoke token — HTTP MCP rejects afterward ─────────────────────────────
  const revokeResp = await httpPostForm(`${ISSUER}/oauth/revoke`, {
    token: accessToken,
    client_id: clientId,
  });
  assert(
    revokeResp.status === 200,
    `6.7 /oauth/revoke returns 200 (got ${revokeResp.status})`,
  );
  // After revocation, HTTP MCP with old token should return 401
  await sleep(100);
  const rejectResp = await httpPostJson(
    `${ISSUER}/mcp`,
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { ...CT_JSON, ...BEARER },
  );
  assert(
    rejectResp.status === 401,
    `6.7 revoked token returns 401 on new HTTP request (got ${rejectResp.status})`,
  );
} finally {
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already dead */
  }
  fs.rmSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

summary("CAT-6");
