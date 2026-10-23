/**
 * `defaultClaudeCodeFn` is asynchronous, stoppable and scrubbed (audit M26,
 * Private/52, 2026-10-15).
 *
 * It was `spawnSync` with a 600 s timeout. For as long as a `claude -p` agent
 * step ran, the bridge's event loop was blocked — no request, cron tick or
 * approval was served — and nothing could stop it: neither a run cancel nor
 * the write kill switch is observable from inside a synchronous call. A
 * failing CLI's stderr was returned verbatim into the run log.
 *
 * Real child processes (a fake `claude` shell script), so what is checked is
 * what actually happens to the process, not to a mock of `child_process`.
 */

import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setKillSwitchReaderForTesting } from "../../governance/killSwitchPolicy.js";
import {
  _resetSecretValuesForTesting,
  registerSecretValue,
} from "../../governance/secretValues.js";
import { defaultClaudeCodeFn } from "../yamlRunner.js";

const posix = process.platform !== "win32";

let workspace: string;
let binDir: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "pw-m26-ws-"));
  execSync("git init -q -b main", { cwd: workspace });
  binDir = mkdtempSync(path.join(os.tmpdir(), "pw-m26-bin-"));
  vi.stubEnv("PATCHWORK_WORKSPACE", workspace);
  _setKillSwitchReaderForTesting(() => false);
});

afterEach(() => {
  _setKillSwitchReaderForTesting(null);
  _resetSecretValuesForTesting();
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

/** Install a fake `claude` whose body is `script`. */
function fakeClaude(script: string): void {
  const p = path.join(binDir, "claude");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  vi.stubEnv("PATCHWORK_CLAUDE_BINARY", p);
}

const pidFile = () => path.join(binDir, "pid");
const ranFile = () => path.join(binDir, "ran");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!posix)("defaultClaudeCodeFn (M26)", () => {
  it("does not block the event loop while the agent runs", async () => {
    fakeClaude("sleep 1\necho done");
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
    }, 50);
    try {
      const out = await defaultClaudeCodeFn("p");
      expect(out).toBe("done");
    } finally {
      clearInterval(t);
    }
    // spawnSync holds the loop for the whole second: zero ticks.
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  it("an abort stops the agent process and resolves promptly", async () => {
    fakeClaude(`echo $$ > "${pidFile()}"\nsleep 30\necho late`);
    const ac = new AbortController();
    const started = Date.now();
    const pending = defaultClaudeCodeFn("p", { signal: ac.signal });
    await waitFor(() => existsSync(pidFile()));
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    ac.abort();
    const out = await pending;
    expect(out).toMatch(/^\[agent step failed: .*aborted/);
    expect(Date.now() - started).toBeLessThan(5000);
    await waitFor(() => !alive(pid));
  });

  it("an already-aborted signal never starts the agent", async () => {
    fakeClaude(`touch "${ranFile()}"\necho ran`);
    const ac = new AbortController();
    ac.abort();
    const out = await defaultClaudeCodeFn("p", { signal: ac.signal });
    expect(out).toMatch(/aborted/);
    expect(existsSync(ranFile())).toBe(false);
  });

  it("an engaged kill switch refuses before the agent starts", async () => {
    fakeClaude(`touch "${ranFile()}"\necho ran`);
    _setKillSwitchReaderForTesting(() => true);
    const out = await defaultClaudeCodeFn("p");
    expect(out).toMatch(/^\[agent step failed: kill_switch_blocked/);
    expect(existsSync(ranFile())).toBe(false);
  });

  it("engaging the kill switch mid-run stops the agent", async () => {
    fakeClaude(`echo $$ > "${pidFile()}"\nsleep 30\necho late`);
    let engaged = false;
    _setKillSwitchReaderForTesting(() => engaged);
    const pending = defaultClaudeCodeFn("p");
    await waitFor(() => existsSync(pidFile()));
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    engaged = true;
    const out = await pending;
    expect(out).toMatch(/^\[agent step failed: kill_switch_blocked/);
    await waitFor(() => !alive(pid));
  }, 10_000);

  it("a failing CLI's stderr is scrubbed before it is returned", async () => {
    registerSecretValue("s3cr3t-value-0001", "test");
    fakeClaude(
      'echo "auth failed: sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA and s3cr3t-value-0001" >&2\nexit 3',
    );
    const out = await defaultClaudeCodeFn("p");
    expect(out).toMatch(/^\[agent step failed: claude exited 3/);
    expect(out).not.toContain("sk-ant-AAAA");
    expect(out).not.toContain("s3cr3t-value-0001");
    expect(out).toContain("REDACTED");
  });

  it("passes the prompt on stdin, never in argv", async () => {
    const argvOut = path.join(binDir, "argv");
    const stdinOut = path.join(binDir, "stdin");
    fakeClaude(
      `for a in "$@"; do printf "%s\\n" "$a" >> "${argvOut}"; done\ncat > "${stdinOut}"\necho ok`,
    );
    const out = await defaultClaudeCodeFn("the private task text");
    expect(out).toBe("ok");
    expect(readFileSync(stdinOut, "utf8")).toBe("the private task text");
    expect(readFileSync(argvOut, "utf8")).not.toContain(
      "the private task text",
    );
  });

  it("a missing binary still reports the configured path", async () => {
    vi.stubEnv("PATCHWORK_CLAUDE_BINARY", path.join(binDir, "nope"));
    const out = await defaultClaudeCodeFn("p");
    expect(out).toContain("claude CLI not found");
    expect(out).toContain(path.join(binDir, "nope"));
  });
});
