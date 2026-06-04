import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    vi.restoreAllMocks();
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
    const start0 = Date.now();
    while (onChange.mock.calls.length === 0 && Date.now() - start0 < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
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
    const start1 = Date.now();
    while (onChange.mock.calls.length === 0 && Date.now() - start1 < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();

    // Bump mtime on an existing file — wait for mtime resolution then poll.
    await new Promise((r) => setTimeout(r, 25));
    writeFileSync(path.join(watchPath, "g.txt"), "v2");
    const start2 = Date.now();
    while (onChange.mock.calls.length === 0 && Date.now() - start2 < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
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

  it("happy path: fs.watch wiring forwards events to onChange", () => {
    // Deterministic: stub fs.watch and drive the change event ourselves.
    // Relying on real OS fs.watch delivery made this flaky under --coverage
    // (events are OS-scheduled and can exceed any fixed wait under load); the
    // real fs.watch path is exercised implicitly elsewhere (pluginWatcher).
    const onChange = vi.fn();
    let listener:
      | ((event: string, filename: string | null) => void)
      | undefined;
    const fakeWatcher = {
      on: vi.fn(),
      close: vi.fn(),
    } as unknown as ReturnType<typeof fs.watch>;
    const watchSpy = vi.spyOn(fs, "watch").mockImplementation(((
      _dir: unknown,
      _opts: unknown,
      cb: (event: string, filename: string | null) => void,
    ) => {
      listener = cb;
      return fakeWatcher;
    }) as unknown as typeof fs.watch);
    try {
      const stop = watchDirectoryWithFallback(tmp, onChange, {
        pollIntervalMs: 20,
      });
      stops.push(stop);
      expect(watchSpy).toHaveBeenCalledWith(
        tmp,
        { recursive: false },
        expect.any(Function),
      );
      // Simulate an fs.watch event firing — no OS timing involved.
      listener?.("change", "new.txt");
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      watchSpy.mockRestore();
    }
  });
});
