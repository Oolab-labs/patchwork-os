/**
 * Claude sign-in relay.
 *
 *   POST /auth/claude/start    → { sessionId, url }
 *   POST /auth/claude/complete → { ok, loggedIn, authMethod }   body { sessionId, code }
 *   POST /auth/claude/cancel   → { ok: true }                   body { sessionId? }
 *   GET  /auth/claude/status   → { loggedIn, authMethod, reason? }
 *   POST /auth/claude/logout   → { ok: true }
 *
 * Sign-in is performed by the UNMODIFIED Claude Code CLI (`claude auth login`),
 * which talks to Anthropic and stores its own login where Claude Code always
 * keeps it. This module only relays two things: the sign-in link the CLI
 * prints (out to the person) and the code the person pastes (into the CLI's
 * stdin). It never sees, stores, logs or returns a Claude credential.
 *
 * Why: Anthropic does not permit applications to run their own Claude.ai
 * login, or to collect, store or intermediate Claude.ai credentials; sign-in
 * must complete through Anthropic's own flow. The previous implementation
 * ran its own OAuth exchange and returned the access token (and dropped the
 * refresh token, so the login also expired within hours).
 *
 * The binary is `PATCHWORK_CLAUDE_BINARY` or `claude` on PATH, run with the
 * bridge's HOME / CLAUDE_CONFIG_DIR so the login lands where every later
 * `claude` invocation by this bridge will find it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  claudeCredentialsUpdatedAt,
  needsSignInAgain,
  readClaudeAuthHealth,
  recordClaudeSignIn,
} from "./claudeAuthHealth.js";
import { ensureCmdShim } from "./winShim.js";

const URL_TIMEOUT_MS = 20_000;
const COMPLETE_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Anthropic's sign-in pages; any other URL the CLI prints is not relayed. */
const SIGN_IN_URL_RE = /https:\/\/(?:claude\.com|claude\.ai)\/[^\s"'<>]+/;

interface LoginSession {
  sessionId: string;
  child: ChildProcess;
  createdAt: number;
  output: string;
  exited: Promise<number | null>;
}

/** One sign-in at a time per bridge: a new start replaces any pending one. */
let current: LoginSession | null = null;

function claudeBinary(): string {
  // npm installs `claude` as a `.cmd` shim on Windows, which spawn() cannot
  // resolve from a bare name; same helper as the Claude subprocess driver.
  return ensureCmdShim(process.env.PATCHWORK_CLAUDE_BINARY || "claude");
}

/** Only what Claude Code needs to find its own config and reach the network. */
function childEnv(): NodeJS.ProcessEnv {
  const keep = [
    "HOME",
    "PATH",
    "USER",
    "LANG",
    "TMPDIR",
    "CLAUDE_CONFIG_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep)
    if (process.env[k] !== undefined) env[k] = process.env[k];
  // Never let a stray credential in the bridge's env decide which account
  // Claude Code signs in as.
  return env;
}

function endSession(s: LoginSession | null): void {
  if (!s) return;
  try {
    s.child.stdin?.end();
  } catch {
    /* already closed */
  }
  if (s.child.exitCode === null) s.child.kill("SIGTERM");
}

/** Test seam: drop any in-flight session. */
export function _resetClaudeLoginForTesting(): void {
  endSession(current);
  current = null;
}

function run(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(claudeBinary(), args, {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, spawnError: err.code ?? "spawn_failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
}

async function readStatus(): Promise<AuthStatus | { error: string }> {
  const r = await run(["auth", "status"], STATUS_TIMEOUT_MS);
  if (r.spawnError) return { error: "claude_not_installed" };
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // Return only these two fields: the rest (e.g. email, organisation) is
    // not this endpoint's business.
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod:
        typeof parsed.authMethod === "string" ? parsed.authMethod : "unknown",
    };
  } catch {
    return { error: "status_unreadable" };
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function parseJson(
  req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// --- POST /auth/claude/start ----------------------------------------------

export async function handleClaudeAuthStart(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  endSession(current);
  current = null;

  let child: ChildProcess;
  try {
    child = spawn(claudeBinary(), ["auth", "login", "--claudeai"], {
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    jsonReply(res, 503, { error: "claude_not_installed" });
    return;
  }

  const session: LoginSession = {
    sessionId: randomBytes(16).toString("hex"),
    child,
    createdAt: Date.now(),
    output: "",
    exited: new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    }),
  };

  const outcome = await new Promise<
    { url: string } | { error: string; status: number }
  >((resolve) => {
    const timer = setTimeout(() => {
      resolve({ error: "sign_in_link_timeout", status: 504 });
    }, URL_TIMEOUT_MS);
    const onData = (d: Buffer) => {
      session.output += d.toString("utf8");
      const m = SIGN_IN_URL_RE.exec(session.output);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[0] });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        error: err.code === "ENOENT" ? "claude_not_installed" : "spawn_failed",
        status: 503,
      });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ error: "sign_in_exited_early", status: 502 });
    });
  });

  if ("error" in outcome) {
    endSession(session);
    jsonReply(res, outcome.status, { error: outcome.error });
    return;
  }
  current = session;
  jsonReply(res, 200, { sessionId: session.sessionId, url: outcome.url });
}

// --- POST /auth/claude/complete -------------------------------------------

export async function handleClaudeAuthComplete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJson(req);
  if (!body) {
    jsonReply(res, 400, { error: "invalid_json" });
    return;
  }
  const { sessionId, code } = body;
  if (
    typeof sessionId !== "string" ||
    typeof code !== "string" ||
    !code.trim()
  ) {
    jsonReply(res, 400, {
      error: "missing_fields",
      detail: "sessionId and code required",
    });
    return;
  }
  const s = current;
  if (
    !s ||
    s.sessionId !== sessionId ||
    Date.now() - s.createdAt > SESSION_TTL_MS ||
    s.child.exitCode !== null
  ) {
    jsonReply(res, 404, {
      error: "session_not_found",
      detail: "Sign-in expired or was replaced. Start again.",
    });
    return;
  }
  current = null;

  // The code goes to Claude Code's stdin and nowhere else: not logged, not
  // stored, not echoed back.
  const outputBefore = s.output.length;
  s.child.stdin?.write(`${code.trim()}\n`);
  const exit = await Promise.race([
    s.exited,
    new Promise<"timeout">((r) =>
      setTimeout(() => r("timeout"), COMPLETE_TIMEOUT_MS),
    ),
  ]);
  endSession(s);
  if (exit === "timeout") {
    jsonReply(res, 504, { error: "sign_in_timeout" });
    return;
  }

  const status = await readStatus();
  if ("error" in status) {
    jsonReply(res, 502, { error: status.error });
    return;
  }
  // The CLI prints "Invalid code" yet still exits 0, and an earlier login
  // would make `status` look signed in, so neither the exit code nor status
  // alone proves THIS code worked: also read what it printed after the code.
  const reply = s.output.slice(outputBefore);
  const rejected = /invalid|error|fail/i.test(reply);
  if (exit !== 0 || rejected || !status.loggedIn) {
    jsonReply(res, 400, {
      error: "invalid_code",
      detail:
        "Claude Code did not accept that code. Copy the whole code and try again.",
    });
    return;
  }
  // A fresh sign-in supersedes any earlier refusal (claudeAuthHealth.ts).
  recordClaudeSignIn();
  jsonReply(res, 200, { ok: true, ...status });
}

// --- POST /auth/claude/cancel ---------------------------------------------

export async function handleClaudeAuthCancel(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await parseJson(req)) ?? {};
  if (
    current &&
    (body.sessionId === undefined || body.sessionId === current.sessionId)
  ) {
    endSession(current);
    current = null;
  }
  jsonReply(res, 200, { ok: true });
}

// --- GET /auth/claude/status ----------------------------------------------

export async function handleClaudeAuthStatus(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const status = await readStatus();
  if ("error" in status) {
    jsonReply(res, status.error === "claude_not_installed" ? 503 : 502, status);
    return;
  }
  // `claude auth status` reports that a sign-in is PRESENT, not that Claude
  // still accepts it. When a Claude task was refused for authentication after
  // the sign-in was last renewed, the honest answer is "not logged in": the
  // person must sign in again. `loggedIn` stays a boolean for existing
  // readers; `reason` says why it is false despite credentials being present.
  if (
    status.loggedIn &&
    needsSignInAgain(readClaudeAuthHealth(), claudeCredentialsUpdatedAt())
  ) {
    jsonReply(res, 200, {
      loggedIn: false,
      authMethod: status.authMethod,
      reason: "needs_signin_again",
    });
    return;
  }
  jsonReply(res, 200, status);
}

// --- POST /auth/claude/logout ---------------------------------------------

export async function handleClaudeAuthLogout(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const r = await run(["auth", "logout"], STATUS_TIMEOUT_MS);
  if (r.spawnError) {
    jsonReply(res, 503, { error: "claude_not_installed" });
    return;
  }
  jsonReply(res, r.code === 0 ? 200 : 502, { ok: r.code === 0 });
}
