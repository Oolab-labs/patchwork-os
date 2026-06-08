/**
 * Claude Code subscription OAuth 2.0 + PKCE flow.
 *
 * Implements the three endpoints the dashboard settings "Connect Claude" UX
 * expects on the bridge:
 *
 *   POST /auth/claude/start    → { sessionId, url }
 *   POST /auth/claude/complete → { token }
 *   POST /auth/claude/cancel   → { ok: true }
 *
 * Flow:
 *   1. start  — generate PKCE verifier/challenge, build the claude.ai auth URL,
 *               store the verifier in an in-memory session map, return the URL.
 *   2. User opens the URL, signs in, and copies the authorization code shown on
 *               https://platform.claude.com/oauth/code/callback.
 *   3. complete — exchange the code + verifier for an access token at
 *               https://api.anthropic.com/v1/oauth/token.  Return the token.
 *   4. Dashboard POSTs the token to /api/auth/anthropic-key → control-plane
 *               stores it encrypted and re-provisions the container with
 *               CLAUDE_CODE_OAUTH_TOKEN=<token> so the subprocess driver works.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Constants (extracted from the claude binary via strings analysis)
// ---------------------------------------------------------------------------

const CLAUDE_OAUTH_CLIENT_ID =
  "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_OAUTH_AUTH_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback";
const CLAUDE_OAUTH_SCOPES = "user:inference user:profile org:create_api_key";

// Sessions expire after 10 minutes — long enough for a user to complete the
// browser flow, short enough not to accumulate stale entries.
const SESSION_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

interface AuthSession {
  sessionId: string;
  codeVerifier: string;
  createdAt: number;
}

const sessions = new Map<string, AuthSession>();

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// Body reader (reuse the same pattern as the bridge's other POST handlers)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /auth/claude/start
// ---------------------------------------------------------------------------

export async function handleClaudeAuthStart(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  pruneExpiredSessions();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const sessionId = randomBytes(16).toString("hex");

  sessions.set(sessionId, { sessionId, codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    scope: CLAUDE_OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: sessionId,
  });

  const url = `${CLAUDE_OAUTH_AUTH_URL}?${params.toString()}`;
  jsonReply(res, 200, { sessionId, url });
}

// ---------------------------------------------------------------------------
// POST /auth/claude/complete  { sessionId, code }
// ---------------------------------------------------------------------------

export async function handleClaudeAuthComplete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: { sessionId?: unknown; code?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
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

  const session = sessions.get(sessionId);
  if (!session) {
    jsonReply(res, 404, {
      error: "session_not_found",
      detail:
        "Session expired or not found. Click 'Start over' to begin again.",
    });
    return;
  }

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    jsonReply(res, 410, {
      error: "session_expired",
      detail:
        "Authorization session expired. Click 'Start over' to begin again.",
    });
    return;
  }

  // Exchange authorization code + PKCE verifier for an access token.
  let tokenRes: Response;
  try {
    tokenRes = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        code: code.trim(),
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
        code_verifier: session.codeVerifier,
      }).toString(),
    });
  } catch (err) {
    jsonReply(res, 502, {
      error: "token_exchange_failed",
      detail: `Network error contacting Anthropic: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const tokenData = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenData.access_token) {
    jsonReply(res, 400, {
      error: "token_exchange_rejected",
      detail:
        tokenData.error_description ??
        tokenData.error ??
        `Anthropic returned ${tokenRes.status}. Make sure you pasted the correct authorization code.`,
    });
    return;
  }

  sessions.delete(sessionId);
  jsonReply(res, 200, { token: tokenData.access_token });
}

// ---------------------------------------------------------------------------
// POST /auth/claude/cancel  { sessionId? }
// ---------------------------------------------------------------------------

export async function handleClaudeAuthCancel(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { sessionId?: unknown };
    if (typeof body.sessionId === "string") sessions.delete(body.sessionId);
  } catch {
    // Body parse failure is fine — we just won't delete a specific session.
  }
  pruneExpiredSessions();
  jsonReply(res, 200, { ok: true });
}
