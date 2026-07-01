/**
 * `patchwork status` (no --port) lock-selection regression.
 *
 * Bug: the no-`--port` path picked the *newest-mtime* `.lock` file in the
 * whole `~/.claude/ide` directory with no `isBridge` filter and no
 * `PATCHWORK_BRIDGE_PORT` check — a completely separate, unfixed copy of the
 * same "wrong lock picked" bug that #1052/#1054 fixed for the MCP shim
 * (`findBridgeLock` / `mcp-stdio-shim.cjs`). A non-bridge IDE lock (e.g. a
 * different editor's `isBridge`-less lock, or another tool's lock) with a
 * newer mtime would be reported as the bridge's status — or worse, an
 * unrelated *older* bridge on another port would silently win over the one
 * `PATCHWORK_BRIDGE_PORT` actually points at.
 *
 * Fix: reuse `findBridgeLockForTask` (already used by the task-runner CLI
 * path) — isBridge-filtered, live-PID-filtered, PATCHWORK_BRIDGE_PORT-aware,
 * workspace-aware when multiple live bridges exist.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const indexTs = join(repoRoot, "src", "index.ts");

let configDir: string;
let lockDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "status-workspace-aware-"));
  lockDir = join(configDir, "ide");
  mkdirSync(lockDir, { recursive: true });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function runStatus(env: Record<string, string> = {}) {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", indexTs, "status", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...env },
    },
  );
  return {
    code: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

describe("patchwork status — workspace-aware lock selection (no --port)", () => {
  it("skips a newer non-bridge (isBridge: false/missing) lock and picks the real bridge", () => {
    // Older lock: the REAL bridge. isBridge:true, live pid (this test's own
    // process — genuinely alive for the duration of the test).
    writeFileSync(
      join(lockDir, "3101.lock"),
      JSON.stringify({
        pid: process.pid,
        authToken: "real-bridge-token",
        workspace: repoRoot,
        isBridge: true,
        ideName: "TestBridge",
      }),
    );
    // Ensure a distinct, newer mtime on the second file.
    const now = Date.now();
    utimesSync(join(lockDir, "3101.lock"), now / 1000 - 10, now / 1000 - 10);

    // Newer lock: an unrelated editor's IDE-owned lock (no isBridge flag) —
    // must NOT be reported as the bridge.
    writeFileSync(
      join(lockDir, "9999.lock"),
      JSON.stringify({
        pid: process.pid,
        workspaceFolders: ["/some/other/project"],
        ideName: "SomeOtherEditor",
      }),
    );

    const { stdout } = runStatus();
    const parsed = JSON.parse(stdout.trim());
    // Must report port 3101 (the real bridge), never 9999 (the IDE lock).
    expect(parsed.port).toBe("3101");
  });

  it("respects PATCHWORK_BRIDGE_PORT over the newest-mtime lock", () => {
    // Two live bridges. The newer one (8888) is NOT the one PATCHWORK_BRIDGE_PORT
    // points at — status must still pick 3101.
    writeFileSync(
      join(lockDir, "3101.lock"),
      JSON.stringify({
        pid: process.pid,
        authToken: "bridge-a-token",
        workspace: repoRoot,
        isBridge: true,
        ideName: "BridgeA",
      }),
    );
    writeFileSync(
      join(lockDir, "8888.lock"),
      JSON.stringify({
        pid: process.pid,
        authToken: "bridge-b-token",
        workspace: "/some/other/workspace",
        isBridge: true,
        ideName: "BridgeB",
      }),
    );

    const { stdout } = runStatus({ PATCHWORK_BRIDGE_PORT: "3101" });
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.port).toBe("3101");
  });
});
