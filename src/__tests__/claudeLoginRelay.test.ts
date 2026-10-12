/**
 * Claude sign-in relay.
 *
 * The bridge must never obtain, hold or return a Claude.ai credential. Sign-in
 * runs the unmodified `claude auth login`, which talks to Anthropic and stores
 * its own login; the bridge only relays the sign-in link out and the code the
 * person typed in. The previous implementation ran its own OAuth exchange
 * with Claude Code's client id and returned the access token — the case
 * Anthropic's terms prohibit — and kept no refresh token.
 *
 * A fake `claude` (a small node script) stands in for the real binary.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observeClaudeTaskForAuth,
  recordClaudeAuthFailure,
} from "../claudeAuthHealth.js";
import {
  _resetClaudeLoginForTesting,
  handleClaudeAuthCancel,
  handleClaudeAuthComplete,
  handleClaudeAuthLogout,
  handleClaudeAuthStart,
  handleClaudeAuthStatus,
} from "../claudeAuthHttp.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const home = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude");
const creds = path.join(home, ".credentials.json");
const [, , a, b] = process.argv;
if (a === "auth" && b === "status") {
  process.stdout.write(JSON.stringify(fs.existsSync(creds)
    ? { loggedIn: true, authMethod: "claude.ai" }
    : { loggedIn: false, authMethod: "none" }));
  process.exit(0);
}
if (a === "auth" && b === "logout") { fs.rmSync(creds, { force: true }); process.exit(0); }
if (a === "auth" && b === "login") {
  process.stdout.write("Opening browser to sign in\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\\nPaste code here if prompted > ");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    if (!buf.includes("\\n")) return;
    const code = buf.split("\\n")[0].trim();
    if (code === "good-code") {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(creds, JSON.stringify({ secret: "stored-by-claude-only" }));
      process.stdout.write("\\nLogin successful.\\n");
      process.exit(0);
    }
    // Mirrors the real CLI: it reports the bad code but still exits 0.
    process.stdout.write("\\nInvalid code. Please make sure the full code was copied.\\n");
    process.exit(0);
  });
  return;
}
process.exit(2);
`;

interface Captured {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

function makeRes(): { res: ServerResponse; done: Promise<Captured> } {
  let resolve!: (c: Captured) => void;
  const done = new Promise<Captured>((r) => {
    resolve = r;
  });
  let status = 0;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(payload: string) {
      resolve({ status, body: JSON.parse(payload), raw: payload });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function makeReq(body?: unknown): IncomingMessage {
  return Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage;
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  body?: unknown,
): Promise<Captured> {
  const { res, done } = makeRes();
  await handler(makeReq(body), res);
  return done;
}

let dir: string;
let configDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-login-"));
  configDir = join(dir, "claude-home");
  const bin = join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  process.env.PATCHWORK_CLAUDE_BINARY = bin;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  // The sign-in health marker lives under the patchwork home; never let a
  // test write the developer's real one.
  process.env.PATCHWORK_HOME = join(dir, "patchwork-home");
  _resetClaudeLoginForTesting();
});

afterEach(() => {
  _resetClaudeLoginForTesting();
  delete process.env.PATCHWORK_CLAUDE_BINARY;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.PATCHWORK_HOME;
});

// The fake CLI is a `#!/usr/bin/env node` script, which Windows cannot
// execute directly, so the spawning tests run on POSIX only. The relay's
// logic is platform-independent; the Windows-specific part (the `.cmd`
// shim) is ensureCmdShim, tested in winShim's own tests.
describe.skipIf(process.platform === "win32")("claude sign-in relay", () => {
  it("start returns Anthropic's sign-in link from the real CLI, and no token", async () => {
    const r = await call(handleClaudeAuthStart);
    expect(r.status).toBe(200);
    expect(typeof r.body.sessionId).toBe("string");
    expect(r.body.url).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&x=1",
    );
    expect(r.body).not.toHaveProperty("token");
  });

  it("complete relays the code; Claude Code stores the login; the bridge returns no credential", async () => {
    const start = await call(handleClaudeAuthStart);
    const r = await call(handleClaudeAuthComplete, {
      sessionId: start.body.sessionId,
      code: "good-code",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      loggedIn: true,
      authMethod: "claude.ai",
    });
    expect(r.raw).not.toContain("good-code");
    expect(r.raw).not.toContain("stored-by-claude-only");
    // The login lives where Claude Code put it, not anywhere the bridge chose.
    expect(existsSync(join(configDir, ".credentials.json"))).toBe(true);
  });

  it("a wrong code is reported as invalid and leaves the user signed out", async () => {
    const start = await call(handleClaudeAuthStart);
    const r = await call(handleClaudeAuthComplete, {
      sessionId: start.body.sessionId,
      code: "wrong",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_code");
    const s = await call(handleClaudeAuthStatus);
    expect(s.body).toEqual({ loggedIn: false, authMethod: "none" });
  });

  it("a wrong code is invalid even when the user is already signed in (CLI exits 0 on a bad code)", async () => {
    const first = await call(handleClaudeAuthStart);
    await call(handleClaudeAuthComplete, {
      sessionId: first.body.sessionId,
      code: "good-code",
    });
    const again = await call(handleClaudeAuthStart);
    const r = await call(handleClaudeAuthComplete, {
      sessionId: again.body.sessionId,
      code: "wrong",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_code");
  });

  it("status and logout reflect Claude Code's own state", async () => {
    const start = await call(handleClaudeAuthStart);
    await call(handleClaudeAuthComplete, {
      sessionId: start.body.sessionId,
      code: "good-code",
    });
    expect((await call(handleClaudeAuthStatus)).body.loggedIn).toBe(true);
    expect((await call(handleClaudeAuthLogout)).status).toBe(200);
    expect((await call(handleClaudeAuthStatus)).body.loggedIn).toBe(false);
  });

  it("an unknown or cancelled session is rejected", async () => {
    const missing = await call(handleClaudeAuthComplete, {
      sessionId: "nope",
      code: "good-code",
    });
    expect(missing.status).toBe(404);
    const start = await call(handleClaudeAuthStart);
    await call(handleClaudeAuthCancel, { sessionId: start.body.sessionId });
    const after = await call(handleClaudeAuthComplete, {
      sessionId: start.body.sessionId,
      code: "good-code",
    });
    expect(after.status).toBe(404);
  });

  it("a second start replaces the first (one sign-in at a time)", async () => {
    const first = await call(handleClaudeAuthStart);
    const second = await call(handleClaudeAuthStart);
    const stale = await call(handleClaudeAuthComplete, {
      sessionId: first.body.sessionId,
      code: "good-code",
    });
    expect(stale.status).toBe(404);
    const ok = await call(handleClaudeAuthComplete, {
      sessionId: second.body.sessionId,
      code: "good-code",
    });
    expect(ok.status).toBe(200);
  });

  it("reports a missing Claude Code install clearly", async () => {
    process.env.PATCHWORK_CLAUDE_BINARY = join(dir, "does-not-exist");
    const r = await call(handleClaudeAuthStart);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("claude_not_installed");
  });

  it("source guard: no OAuth exchange, client id or token handling in the module", () => {
    const src = readFileSync(
      join(__dirname, "..", "claudeAuthHttp.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/oauth\/token/);
    expect(src).not.toMatch(/9d1c250a-e61b-44d9-88ed-5944d1962f5e/);
    expect(src).not.toMatch(/code_verifier|codeVerifier/);
  });
});

/**
 * "Logged in" must not mean "credentials are present".
 *
 * Observed live: `GET /auth/claude/status` said `{loggedIn: true}` while
 * Claude rejected the stored sign-in ("OAuth access token has been revoked")
 * on every agent step. `claude auth status` reads local state; it does not ask
 * Anthropic whether the token still works. The runtime already holds better
 * evidence — the refusal itself — so a Claude auth failure recorded AFTER the
 * credentials were last updated makes status report `loggedIn: false` with
 * `reason: "needs_signin_again"`. A newer sign-in, a newer credentials file,
 * or a later successful Claude task clears it. No model call is made.
 */
describe.skipIf(process.platform === "win32")(
  "status reports a refused sign-in, not credential presence",
  () => {
    const credsPath = () => join(configDir, ".credentials.json");
    /** Credentials written by Claude Code at `atMs` (e.g. a terminal sign-in). */
    function credentialsWrittenAt(atMs: number) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(credsPath(), JSON.stringify({ secret: "x" }));
      utimesSync(credsPath(), atMs / 1000, atMs / 1000);
    }
    const REVOKED = {
      status: "error",
      errorMessage: "Process exited with code 1",
      output:
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked. Please obtain a new token or refresh your existing token.",
    };

    it("credentials exist but an auth failure was recorded after them → loggedIn false", async () => {
      const t0 = Date.now() - 60_000;
      credentialsWrittenAt(t0);
      recordClaudeAuthFailure(t0 + 10_000);
      const r = await call(handleClaudeAuthStatus);
      expect(r.status).toBe(200);
      expect(r.body.loggedIn).toBe(false);
      expect(r.body.reason).toBe("needs_signin_again");
      expect(r.body.authMethod).toBe("claude.ai");
    });

    it("a newer sign-in through the relay clears it", async () => {
      const t0 = Date.now() - 60_000;
      credentialsWrittenAt(t0);
      recordClaudeAuthFailure(t0 + 10_000);
      const start = await call(handleClaudeAuthStart);
      const done = await call(handleClaudeAuthComplete, {
        sessionId: start.body.sessionId,
        code: "good-code",
      });
      expect(done.body).toEqual({
        ok: true,
        loggedIn: true,
        authMethod: "claude.ai",
      });
      // Pin the credentials file back before the refusal, as when Claude
      // Code keeps its login in the OS keychain: only the relay's own record
      // of the sign-in can clear the refusal now.
      utimesSync(credsPath(), t0 / 1000, t0 / 1000);
      const r = await call(handleClaudeAuthStatus);
      expect(r.body).toEqual({ loggedIn: true, authMethod: "claude.ai" });
    });

    it("credentials updated after the failure (signed in elsewhere) → loggedIn true", async () => {
      const t0 = Date.now() - 60_000;
      recordClaudeAuthFailure(t0);
      credentialsWrittenAt(t0 + 10_000);
      const r = await call(handleClaudeAuthStatus);
      expect(r.body).toEqual({ loggedIn: true, authMethod: "claude.ai" });
    });

    it("a Claude task refused for auth marks it; a later successful task clears it", async () => {
      const t0 = Date.now() - 60_000;
      credentialsWrittenAt(t0);
      observeClaudeTaskForAuth(REVOKED, t0 + 10_000);
      expect((await call(handleClaudeAuthStatus)).body.reason).toBe(
        "needs_signin_again",
      );
      observeClaudeTaskForAuth({ status: "done", output: "ok" }, t0 + 20_000);
      expect((await call(handleClaudeAuthStatus)).body).toEqual({
        loggedIn: true,
        authMethod: "claude.ai",
      });
    });

    it("a task that failed for any other reason records nothing", async () => {
      const t0 = Date.now() - 60_000;
      credentialsWrittenAt(t0);
      observeClaudeTaskForAuth(
        {
          status: "error",
          errorMessage: "Process exited with code 1",
          output: "the issue tracker MCP server returned 401",
        },
        t0 + 10_000,
      );
      expect((await call(handleClaudeAuthStatus)).body).toEqual({
        loggedIn: true,
        authMethod: "claude.ai",
      });
    });

    it("signed out stays exactly signed out (no reason invented)", async () => {
      recordClaudeAuthFailure(Date.now());
      const r = await call(handleClaudeAuthStatus);
      expect(r.body).toEqual({ loggedIn: false, authMethod: "none" });
    });

    it("the bridge feeds Claude orchestrator outcomes into it (wiring guard)", () => {
      const src = readFileSync(join(__dirname, "..", "bridge.ts"), "utf8");
      expect(src).toMatch(
        /driver\.name === "subprocess"[\s\S]{0,200}observeClaudeTaskForAuth\(/,
      );
    });
  },
);
