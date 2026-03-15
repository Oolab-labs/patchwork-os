/**
 * Tests for mcp-stdio-shim.cjs pendingLines overflow behaviour.
 *
 * Bug: when the bridge WebSocket is not yet open and stdin receives more
 * than MAX_PENDING_LINES (1000) messages, the excess are silently dropped
 * with no warning. The shim should write a warning to stderr so operators
 * can diagnose the problem.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SHIM_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "mcp-stdio-shim.cjs",
);

let tmpDir: string;
let shimProcess: ChildProcess | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-overflow-test-"));
  fs.mkdirSync(path.join(tmpDir, "ide"), { mode: 0o700 });
});

afterEach(async () => {
  shimProcess?.kill();
  shimProcess = null;
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pendingLines overflow", () => {
  it("writes a warning to stderr when more than MAX_PENDING_LINES messages are queued", async () => {
    // Start shim with no lock file so it polls — WebSocket stays unconnected.
    // stdin messages will accumulate in pendingLines until overflow.
    const proc = spawn(process.execPath, [SHIM_PATH], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    shimProcess = proc;

    const stderrChunks: string[] = [];
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => stderrChunks.push(d));

    // Write 1001 newline-delimited JSON-RPC messages to stdin (limit is 1000).
    const msg = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
    for (let i = 0; i < 1001; i++) {
      proc.stdin?.write(msg + "\n");
    }
    // Flush and give the shim a moment to process
    await new Promise((r) => setTimeout(r, 300));

    const stderrAll = stderrChunks.join("");

    // BUG: currently the 1001st message is silently dropped — no warning → FAILS
    expect(stderrAll).toMatch(/overflow/i);
  });
});
