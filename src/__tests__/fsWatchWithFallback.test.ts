import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDirectoryWithFallback } from "../fsWatchWithFallback.js";

/**
 * These tests cover the polling fallback path because that's the brittle
 * surface area the audit flagged. The fs.watch happy path is exercised
 * implicitly across the rest of the suite (pluginWatcher tests, etc.) so
 * we focus here on:
 *   - fs.watch throwing → polling starts
 *   - directory created later → polling sees it
 *   - file mtime advances → onChange fires
 *   - stop() releases timer
 */

describe("watchDirectoryWithFallback — polling fallback", () => {
  let tmp: string;
  let stops: Array<() => void> = [];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "fs-watch-fallback-"));
    stops = [];
  });

  afterEach(() => {
    for (const stop of stops) {
      try {
        stop();
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("falls back to polling when fs.watch throws (non-existent dir)", async () => {
    const missing = path.join(tmp, "does-not-exist-yet");
    const onChange = vi.fn();
    const warn = vi.fn();
    const stop = watchDirectoryWithFallback(missing, onChange, {
      pollIntervalMs: 20,
      logger: { warn },
    });
    stops.push(stop);
    // Polling must have started — logger.warn called with "fs.watch threw".
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/fs\.watch threw/);

    // Create the directory + a file. Polling should detect on its next tick.
    require("node:fs").mkdirSync(missing);
    writeFileSync(path.join(missing, "a.txt"), "hi");
    await new Promise((r) => setTimeout(r, 80));
    expect(onChange).toHaveBeenCalled();
  });

  it("polling fires onChange when a file's mtime advances", async () => {
    const onChange = vi.fn();
    // Force the polling path by pointing fs.watch at a directory it can't
    // watch — actually easier: just always-polling via fs.watch mock isn't
    // available here, so use the missing-dir trigger.
    const dir = path.join(tmp, "p");
    require("node:fs").mkdirSync(dir);
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "v1");

    // Watch a sibling missing dir to force polling, then mkdir it pointing
    // at the same `dir`. Simpler: just point at a path that fs.watch
    // refuses. On macOS/Linux, fs.watch on a regular file works, on a
    // missing path throws. Use missing then mkdir to it.
    const watchPath = path.join(tmp, "watched");
    const stop = watchDirectoryWithFallback(watchPath, onChange, {
      pollIntervalMs: 20,
    });
    stops.push(stop);

    require("node:fs").mkdirSync(watchPath);
    writeFileSync(path.join(watchPath, "g.txt"), "v1");
    await new Promise((r) => setTimeout(r, 60));
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();

    // Bump mtime on an existing file.
    await new Promise((r) => setTimeout(r, 20)); // ensure mtime resolution
    writeFileSync(path.join(watchPath, "g.txt"), "v2");
    await new Promise((r) => setTimeout(r, 60));
    expect(onChange).toHaveBeenCalled();
  });

  it("stop() halts polling — onChange not fired after stop", async () => {
    const onChange = vi.fn();
    const watchPath = path.join(tmp, "watched");
    const stop = watchDirectoryWithFallback(watchPath, onChange, {
      pollIntervalMs: 20,
    });
    stop();
    require("node:fs").mkdirSync(watchPath);
    writeFileSync(path.join(watchPath, "x.txt"), "v");
    await new Promise((r) => setTimeout(r, 60));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("happy path: fs.watch succeeds and fires onChange", async () => {
    const onChange = vi.fn();
    const stop = watchDirectoryWithFallback(tmp, onChange, {
      pollIntervalMs: 20,
    });
    stops.push(stop);
    writeFileSync(path.join(tmp, "new.txt"), "x");
    // fs.watch fires within ~10ms on local filesystems
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).toHaveBeenCalled();
  });
});
