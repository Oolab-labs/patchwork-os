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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  timeoutMs = 2000,
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

describe("watchFlags()", () => {
  it("picks up a sibling-process flag write within the debounce window", async () => {
    expect(isWriteKillSwitchActive()).toBe(false);
    stopWatch = watchFlags();

    // Simulate a sibling process (e.g. `patchwork kill-switch engage`
    // fallback path) writing the flags file.
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });

    const converged = await waitFor(() => isWriteKillSwitchActive() === true);
    expect(converged).toBe(true);
  });

  it("propagates release writes too", async () => {
    // Start with kill-switch engaged in memory.
    setFlag(KILL_SWITCH_WRITES, true, false);
    expect(isWriteKillSwitchActive()).toBe(true);

    stopWatch = watchFlags();

    // Sibling writes release.
    writeFlagsFile({ [KILL_SWITCH_WRITES]: false });

    const converged = await waitFor(() => isWriteKillSwitchActive() === false);
    expect(converged).toBe(true);
  });

  it("debounces rapid sibling writes — final state wins", async () => {
    stopWatch = watchFlags();
    // Three writes within ~50ms; the 100ms debounce coalesces them
    // and the watcher reloads once, picking up the final state.
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });
    writeFlagsFile({ [KILL_SWITCH_WRITES]: false });
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });

    const converged = await waitFor(() => isWriteKillSwitchActive() === true);
    expect(converged).toBe(true);
  });

  it("stop() halts further reloads", async () => {
    stopWatch = watchFlags();
    writeFlagsFile({ [KILL_SWITCH_WRITES]: true });
    await waitFor(() => isWriteKillSwitchActive() === true);

    // Stop the watcher, then write a release. The in-memory value
    // should NOT change because the watcher is no longer listening.
    stopWatch();
    stopWatch = null;
    writeFlagsFile({ [KILL_SWITCH_WRITES]: false });
    // Wait a beat to be sure no event was processed.
    await new Promise((r) => setTimeout(r, 300));
    expect(isWriteKillSwitchActive()).toBe(true);
  });

  it("does not throw when the flags directory does not exist", () => {
    rmSync(join(homeDir, "config"), { recursive: true, force: true });
    // watchFlags should silently no-op (try/catch around fs.watch).
    expect(() => {
      stopWatch = watchFlags();
    }).not.toThrow();
  });
});
