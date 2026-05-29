/**
 * Tests for `watchFlags()` — the fs.watch wiring that picks up
 * cross-process changes to `~/.patchwork/config/flags.json` and
 * reloads in-memory FLAG_VALUES without a restart.
 *
 * v2-S1 + v2-B2 from issue #422: closes the "no bridge reachable →
 * CLI fallback writes flags.json → running bridge ignores it" gap.
 * Also enables multi-bridge fleets: when bridge A writes via its
 * `/kill-switch` endpoint, bridge B picks up the change via this
 * watcher.
 *
 * Uses real fs.watch with PATCHWORK_HOME pointed at a tmpdir. Each
 * test writes a flags.json from a "sibling process" perspective and
 * asserts the watching bridge's in-memory state converges within a
 * bounded poll window.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetEnvLockForTesting,
  isWriteKillSwitchActive,
  KILL_SWITCH_WRITES,
  setFlag,
  watchFlags,
} from "../featureFlags.js";

let homeDir: string;
let flagsPath: string;
let stopWatch: (() => void) | null = null;

async function waitFor(
  predicate: () => boolean,
  // 5s: enough for 100ms debounce + fs.watch event latency under CI parallel load.
  // The test itself times out at vitest's testTimeout (15s) so this stays well under.
  timeoutMs = 5000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function writeFlagsFile(values: Record<string, boolean>): void {
  writeFileSync(flagsPath, JSON.stringify(values, null, 2));
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "pw-watch-flags-"));
  process.env.PATCHWORK_HOME = homeDir;
  mkdirSync(join(homeDir, "config"), { recursive: true });
  flagsPath = join(homeDir, "config", "flags.json");
  _resetEnvLockForTesting();
  if (isWriteKillSwitchActive()) {
    setFlag(KILL_SWITCH_WRITES, false, false);
  }
});

afterEach(() => {
  if (stopWatch) {
    stopWatch();
    stopWatch = null;
  }
  delete process.env.PATCHWORK_HOME;
  _resetEnvLockForTesting();
  if (isWriteKillSwitchActive()) {
    setFlag(KILL_SWITCH_WRITES, false, false);
  }
  rmSync(homeDir, { recursive: true, force: true });
});

// Pure mtime-polling watcher injected into watchFlags tests. Avoids relying on
// fs.watch event delivery which is unreliable under heavy parallel CI load
// (kqueue/inotify fd limits, deferred event delivery).
// fs.watch integration is tested elsewhere (fsWatchWithFallback.test.ts).
function makePollingWatcher(dir: string, onChange: () => void): () => void {
  const flagsFile = join(dir, "flags.json");
  let stopped = false;
  let lastMtime = 0;

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const mtime = statSync(flagsFile).mtimeMs;
      if (mtime !== lastMtime) {
        lastMtime = mtime;
        onChange();
      }
    } catch {
      /* flags.json doesn't exist yet — ignore */
    }
  }, 20);
  if (typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

const watchOpts = { debounceMs: 10, watcherFn: makePollingWatcher };

describe("watchFlags()", () => {
  it("picks up a sibling-process flag write within the debounce window", async () => {
    expect(isWriteKillSwitchActive()).toBe(false);
    stopWatch = watchFlags(watchOpts);

    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });

    const converged = await waitFor(() => isWriteKillSwitchActive() === true);
    expect(converged).toBe(true);
  });

  it("propagates release writes too", async () => {
    setFlag(KILL_SWITCH_WRITES, true, false);
    expect(isWriteKillSwitchActive()).toBe(true);

    stopWatch = watchFlags(watchOpts);

    writeFlagsFile({ [KILL_SWITCH_WRITES]: false });

    const converged = await waitFor(() => isWriteKillSwitchActive() === false);
    expect(converged).toBe(true);
  });

  it("debounces rapid sibling writes — final state wins", async () => {
    stopWatch = watchFlags(watchOpts);
    // Three writes within ~20ms; the 10ms debounce coalesces them and
    // the watcher reloads once, picking up the final (true) state.
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });
    writeFlagsFile({ [KILL_SWITCH_WRITES]: false });
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });

    const converged = await waitFor(() => isWriteKillSwitchActive() === true);
    expect(converged).toBe(true);
  });

  it("stop() halts further reloads", async () => {
    stopWatch = watchFlags(watchOpts);
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });
    await waitFor(() => isWriteKillSwitchActive() === true);

    stopWatch();
    stopWatch = null;
    writeFlagsFile({ [KILL_SWITCH_WRITES]: false });
    // Wait several poll cycles to confirm no reload fires.
    await new Promise((r) => setTimeout(r, 150));
    expect(isWriteKillSwitchActive()).toBe(true);
  });

  it("does not throw when the flags directory does not exist", () => {
    rmSync(join(homeDir, "config"), { recursive: true, force: true });
    expect(() => {
      stopWatch = watchFlags(watchOpts);
    }).not.toThrow();
  });
});
