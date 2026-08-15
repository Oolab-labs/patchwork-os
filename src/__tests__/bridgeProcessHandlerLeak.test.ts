/**
 * A stopped bridge must not keep process-level handlers installed (#1386).
 *
 * `start()` registers five listeners on `process` — SIGINT, SIGTERM, SIGHUP,
 * `unhandledRejection`, `uncaughtException`. They were only ever removed when
 * ANOTHER bridge started in the same process; `stop()` removed none.
 *
 * So a stopped bridge's handlers stayed live, closing over its sessions, its
 * logger, and a `shutdown` that calls `process.exit`. After a test stops its
 * bridge, any later uncaught exception anywhere in that worker — an
 * EADDRINUSE from an unrelated server is the obvious candidate on Windows —
 * runs the DEAD bridge's `uncaughtException` handler, which shuts down and
 * exits. The worker dies mid-suite with no verdict, which is exactly what
 * #1386 describes: `Test` green, `Coverage` red, log ending in ordinary
 * stderr with no summary, passing on re-run.
 *
 * Measured before the fix, in one vitest worker:
 *
 *     before start  uncaughtException 1 · unhandledRejection 1 · SIGINT 0
 *     after  start  2 · 2 · 1
 *     after  stop   2 · 2 · 1   ← unchanged
 *
 * The counts are asserted as DELTAS against the count before `start()`, not
 * as absolutes: vitest installs its own handlers, and an absolute assertion
 * would break whenever the runner changed rather than when the bridge
 * regressed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Bridge } from "../bridge.js";
import { makeConfig } from "./helpers/fixtures.js";

const EVENTS = [
  "uncaughtException",
  "unhandledRejection",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
] as const;

function counts(): Record<string, number> {
  return Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));
}

describe("a stopped bridge detaches its process handlers", () => {
  let tempDir = "";
  let prevHome: string | undefined;
  let prevClaudeConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handler-leak-"));
    prevHome = process.env.HOME;
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tempDir;
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, ".claude");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function bridgeFor(): Bridge {
    const workspace = fs.mkdtempSync(path.join(tempDir, "workspace-"));
    return new Bridge(
      makeConfig({
        workspace,
        workspaceFolders: [workspace],
        ideName: "Test",
        maxResultSize: 512 * 1024,
        gracePeriodMs: 1_000,
        driver: "none",
        toolRateLimit: 10,
        fixedToken: "bridge-fixed-token",
        fullMode: false,
        analyticsEnabled: false,
        wsPingIntervalMs: 0,
        lspVerbosity: "minimal",
      }),
    );
  }

  it("returns every listener count to where it started", async () => {
    const before = counts();

    const bridge = bridgeFor();
    await bridge.start();

    // Control: without this the test passes just as well against a bridge
    // that never registered anything, which would assert nothing at all.
    const during = counts();
    for (const e of EVENTS) {
      expect(during[e], `${e} not installed by start()`).toBe(before[e] + 1);
    }

    await bridge.stop();

    const after = counts();
    for (const e of EVENTS) {
      expect(after[e], `${e} still installed after stop()`).toBe(before[e]);
    }
  });

  it("does not accumulate across repeated start/stop cycles", async () => {
    const before = counts();
    for (let i = 0; i < 3; i++) {
      const bridge = bridgeFor();
      await bridge.start();
      await bridge.stop();
    }
    expect(counts()).toEqual(before);
  });

  it("an older bridge stopping does not disarm a newer one", async () => {
    // `activeSignalHandlers` is module-global and the newest starter owns it.
    // A naive "remove everything on stop" would let a straggler tear down the
    // live bridge's handlers, which is a worse bug than the leak: the running
    // bridge would stop shutting down cleanly on SIGTERM.
    const before = counts();

    const older = bridgeFor();
    await older.start();
    const newer = bridgeFor();
    await newer.start();

    // start() detaches the previous set, so exactly one set is installed.
    for (const e of EVENTS) expect(counts()[e]).toBe(before[e] + 1);

    await older.stop();
    for (const e of EVENTS) {
      expect(counts()[e], `${e} disarmed by the older bridge`).toBe(
        before[e] + 1,
      );
    }

    await newer.stop();
    expect(counts()).toEqual(before);
  });
});
