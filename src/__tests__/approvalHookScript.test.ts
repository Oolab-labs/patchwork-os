import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end-ish tests for the PreToolUse hook shell script. Spins up a tiny
 * HTTP server that impersonates the bridge /approvals endpoint, writes a fake
 * lock file, and runs the real shell script against it with a CC-shaped
 * stdin JSON payload.
 */

const script = path.resolve(
  __dirname,
  "..",
  "..",
  "scripts",
  "patchwork-approval-hook.sh",
);

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runHook(
  stdin: string,
  env: Record<string, string>,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const proc = spawn("bash", [script], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.stdin.end(stdin);
  });
}

function buildPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "test-session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp/workspace",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi", description: "greeting" },
    tool_use_id: "toolu_test",
    ...overrides,
  });
}

// Bash-script suite — patchwork-approval-hook.sh can't run natively on Windows.
describe.skipIf(process.platform === "win32")(
  "patchwork-approval-hook.sh",
  () => {
    let tmp: string;
    let lockDir: string;
    let server: http.Server;
    let port: number;
    let lastRequest: {
      headers: http.IncomingHttpHeaders;
      body: Record<string, unknown>;
    } | null = null;
    let nextResponse: unknown = { decision: "allow", reason: "ok" };

    beforeEach(async () => {
      tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-hook-"));
      lockDir = path.join(tmp, "ide");
      require("node:fs").mkdirSync(lockDir, { recursive: true });
      lastRequest = null;

      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            lastRequest = { headers: req.headers, body };
          } catch {
            lastRequest = { headers: req.headers, body: {} };
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(nextResponse));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      port = (server.address() as { port: number }).port;

      // Write a fake lock file keyed to this port with isBridge:true.
      writeFileSync(
        path.join(lockDir, `${port}.lock`),
        JSON.stringify({ authToken: "test-token", isBridge: true, pid: 1 }),
        { mode: 0o600 },
      );
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmp, { recursive: true, force: true });
    });

    it("parses CC stdin JSON and POSTs normalized body to /approvals", async () => {
      nextResponse = { decision: "allow", reason: "ok" };
      const r = await runHook(buildPayload(), {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      expect(r.code).toBe(0);
      expect(lastRequest).not.toBeNull();
      expect(lastRequest!.body).toMatchObject({
        toolName: "Bash",
        specifier: "echo hi",
        permissionMode: "default",
        sessionId: "test-session",
      });
      // tool_input arrived as params object.
      expect(lastRequest!.body.params).toMatchObject({
        command: "echo hi",
      });
      expect(lastRequest!.headers.authorization).toBe("Bearer test-token");
    });

    it("exits 2 with hookSpecificOutput JSON on deny", async () => {
      nextResponse = { decision: "deny", reason: "policy" };
      const r = await runHook(buildPayload(), {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      expect(r.code).toBe(2);
      // stdout is the hookSpecificOutput JSON for modern CC.
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput).toMatchObject({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      });
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
        "policy",
      );
      // stderr has human-readable version for old CC.
      expect(r.stderr).toContain("Patchwork: approval denied for Bash");
    });

    it("skips the gate entirely in bypassPermissions mode", async () => {
      const r = await runHook(
        buildPayload({ permission_mode: "bypassPermissions" }),
        {
          CLAUDE_CONFIG_DIR: tmp,
          PATCHWORK_BRIDGE_PORT: String(port),
        },
      );
      expect(r.code).toBe(0);
      // The bridge was never called — no request recorded.
      expect(lastRequest).toBeNull();
    });

    it("skips the gate entirely in auto mode", async () => {
      const r = await runHook(buildPayload({ permission_mode: "auto" }), {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      expect(r.code).toBe(0);
      expect(lastRequest).toBeNull();
    });

    it("fails open (exit 0) when stdin is empty and no env fallback", async () => {
      const r = await runHook("", {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      expect(r.code).toBe(0);
      expect(lastRequest).toBeNull();
    });

    // ADR-0014: the gate fails CLOSED when the bridge is unreachable.
    it("fails closed (exit 2 deny) when bridge request fails", async () => {
      // Kill the server before invoking the hook.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const r = await runHook(buildPayload(), {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      expect(r.code).toBe(2);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(r.stderr).toContain("failing closed");
    });

    it("fails closed (exit 2) when no bridge lock can be discovered", async () => {
      // A config dir with no ide/ lock directory → no bridge discoverable.
      const emptyCfg = mkdtempSync(path.join(os.tmpdir(), "patchwork-nolock-"));
      try {
        const r = await runHook(buildPayload(), {
          CLAUDE_CONFIG_DIR: emptyCfg,
          PATCHWORK_BRIDGE_PORT: "59999",
        });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("no_bridge");
      } finally {
        rmSync(emptyCfg, { recursive: true, force: true });
      }
    });

    it("PATCHWORK_APPROVAL_FAIL_OPEN=1 restores allow-on-unreachable (exit 0)", async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const r = await runHook(buildPayload(), {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
        PATCHWORK_APPROVAL_FAIL_OPEN: "1",
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("PATCHWORK_APPROVAL_FAIL_OPEN set");
    });

    it("ignores injection attempts in tool_input (parsed as JSON, not shell)", async () => {
      nextResponse = { decision: "allow" };
      const nasty = buildPayload({
        tool_input: {
          command: "rm -rf /; $(whoami)",
          description: "'; echo pwned; #",
        },
      });
      const r = await runHook(nasty, {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      expect(r.code).toBe(0);
      expect(lastRequest!.body.params).toMatchObject({
        command: "rm -rf /; $(whoami)",
        description: "'; echo pwned; #",
      });
      // stdout should NOT contain "pwned" — injection didn't execute.
      expect(r.stdout).not.toContain("pwned");
    });

    it("tolerates a malicious response body (no python -c injection)", async () => {
      nextResponse = "not-json''' ; import os; os.system('echo pwned'); '''"; // string, not object
      const r = await runHook(buildPayload(), {
        CLAUDE_CONFIG_DIR: tmp,
        PATCHWORK_BRIDGE_PORT: String(port),
      });
      // ADR-0014: a malformed/non-object response is a degenerate bridge reply
      // → treated as unreachable → fail closed (exit 2), never silent allow.
      // The injection still must not execute regardless of exit code.
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("bad_response");
      expect(r.stdout).not.toContain("pwned");
      expect(r.stderr).not.toContain("pwned");
    });
  },
);
