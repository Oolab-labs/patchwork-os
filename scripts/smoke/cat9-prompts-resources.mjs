/**
 * Category 9 — MCP Prompts & Resources.
 *
 * 9.1  prompts/list returns array of prompts with name/description
 * 9.2  prompts/get returns spec-compliant { description, messages } for a known prompt
 * 9.3  prompts/get returns error for unknown prompt name
 * 9.4  resources/list returns { resources: [...] } array
 * 9.5  resources/read returns text content for a valid workspace file
 * 9.6  resources/read returns error for out-of-workspace URI
 * 9.7  Both endpoints reject request before initialize
 *
 * Usage: node cat9-prompts-resources.mjs <port> <token>
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  assert,
  mcpHandshake,
  readLock,
  sleep,
  summary,
  waitForBridge,
  wsSend,
} from "./helpers.mjs";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const PORT = Number(process.argv[2]);
const TOKEN = process.argv[3];

if (!PORT || !TOKEN) {
  console.error("Usage: node cat9-prompts-resources.mjs <port> <token>");
  process.exit(1);
}

console.log("\n[CAT-9] MCP Prompts & Resources");

await waitForBridge(PORT, 5_000);

// ── 9.7 pre-init rejection ────────────────────────────────────────────────────
// Open a raw WS without performing initialize handshake
const rawWs = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
    headers: { "x-claude-code-ide-authorization": TOKEN },
  });
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
});

const preInitResp = await wsSend(rawWs, {
  jsonrpc: "2.0",
  id: 1,
  method: "prompts/list",
  params: {},
});
assert(
  preInitResp.error?.code === -32600,
  "9.7 prompts/list before initialize returns INVALID_REQUEST (-32600)",
);
rawWs.close();
await sleep(600); // connection throttle: bridge enforces 500ms between rapid WS upgrades

// ── Initialized session ────────────────────────────────────────────────────────
const ws = await mcpHandshake(PORT, TOKEN);

// ── 9.1 prompts/list ──────────────────────────────────────────────────────────
const listResp = await wsSend(ws, {
  jsonrpc: "2.0",
  id: 10,
  method: "prompts/list",
  params: {},
});
const prompts = listResp.result?.prompts;
assert(
  Array.isArray(prompts) && prompts.length > 0,
  "9.1 prompts/list returns non-empty array",
);
const firstPrompt = prompts[0];
assert(
  typeof firstPrompt?.name === "string" &&
    typeof firstPrompt?.description === "string",
  "9.1 each prompt has name and description strings",
);

// ── 9.2 prompts/get known prompt ──────────────────────────────────────────────
// Pick a prompt with no required arguments so we can invoke it without parameters
const noArgPrompt =
  prompts.find((p) => !p.arguments || p.arguments.every((a) => !a.required)) ??
  prompts[0];
const knownName = noArgPrompt.name;
const getResp = await wsSend(ws, {
  jsonrpc: "2.0",
  id: 11,
  method: "prompts/get",
  params: { name: knownName, arguments: {} },
});
const promptResult = getResp.result;
assert(
  Array.isArray(promptResult?.messages) && promptResult.messages.length > 0,
  `9.2 prompts/get "${knownName}" returns messages array`,
);
const msg0 = promptResult.messages[0];
assert(
  (msg0?.role === "user" || msg0?.role === "assistant") &&
    msg0?.content?.type === "text" &&
    typeof msg0?.content?.text === "string",
  "9.2 first message has role + content.type=text + content.text string",
);

// ── 9.3 prompts/get unknown name ──────────────────────────────────────────────
const unknownResp = await wsSend(ws, {
  jsonrpc: "2.0",
  id: 12,
  method: "prompts/get",
  params: { name: "this-prompt-does-not-exist-xyz", arguments: {} },
});
assert(unknownResp.error != null, "9.3 prompts/get unknown name returns error");

// ── 9.4 resources/list ────────────────────────────────────────────────────────
const resListResp = await wsSend(ws, {
  jsonrpc: "2.0",
  id: 20,
  method: "resources/list",
  params: {},
});
const resources = resListResp.result?.resources;
assert(Array.isArray(resources), "9.4 resources/list returns resources array");

// ── 9.5 resources/read valid file ─────────────────────────────────────────────
// Write a sentinel file so we have a guaranteed readable resource
const LOCK_CONTENT = readLock(PORT);
const workspace = LOCK_CONTENT.workspace;
const sentinelPath = path.join(workspace, "smoke-cat9-sentinel.txt");
fs.writeFileSync(sentinelPath, "cat9 smoke sentinel content", "utf-8");

const readResp = await wsSend(ws, {
  jsonrpc: "2.0",
  id: 21,
  method: "resources/read",
  params: { uri: `file://${sentinelPath}` },
});
fs.rmSync(sentinelPath, { force: true });

assert(
  Array.isArray(readResp.result?.contents) &&
    readResp.result.contents.length > 0,
  "9.5 resources/read valid file returns contents array",
);
const content0 = readResp.result.contents[0];
assert(
  typeof content0?.text === "string" &&
    content0.text.includes("cat9 smoke sentinel content"),
  "9.5 contents[0].text matches written content",
);

// ── 9.6 resources/read outside workspace ──────────────────────────────────────
const outsideResp = await wsSend(ws, {
  jsonrpc: "2.0",
  id: 22,
  method: "resources/read",
  params: { uri: "file:///etc/passwd" },
});
assert(
  outsideResp.error != null,
  "9.6 resources/read outside workspace returns error",
);

ws.close();
summary("CAT-9");
