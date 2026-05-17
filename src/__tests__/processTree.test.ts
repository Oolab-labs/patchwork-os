import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: execFileSyncMock };
});

const { treeKill, treeKillPid } = await import("../processTree.js");

const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function fakeChild(opts: {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill?: ReturnType<typeof vi.fn>;
}): ChildProcess {
  return {
    pid: opts.pid,
    exitCode: opts.exitCode ?? null,
    signalCode: opts.signalCode ?? null,
    kill: opts.kill ?? vi.fn(() => true),
  } as unknown as ChildProcess;
}

describe("treeKill", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vi.spyOn return type is tricky to express across vitest versions
  let processKillSpy: any;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(ORIG_PLATFORM);
  });

  describe("on win32", () => {
    beforeEach(() => setPlatform("win32"));

    it("invokes taskkill /F /T /PID AND child.kill backstop", () => {
      const kill = vi.fn(() => true);
      treeKill(fakeChild({ pid: 1234, kill }));
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "taskkill",
        ["/F", "/T", "/PID", "1234"],
        expect.objectContaining({ stdio: "ignore", windowsHide: true }),
      );
      // Backstop fires the `close` event for test stubs that override
      // child.kill, and is a no-op on real Windows since taskkill already
      // killed the immediate child.
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(processKillSpy).not.toHaveBeenCalled();
    });

    it("swallows taskkill failures (process already gone)", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(() => treeKill(fakeChild({ pid: 1234 }))).not.toThrow();
    });
  });

  describe("on posix", () => {
    beforeEach(() => setPlatform("linux"));

    it("signals the negative pid (process group) AND calls child.kill", () => {
      const kill = vi.fn(() => true);
      treeKill(fakeChild({ pid: 5678, kill }));
      expect(processKillSpy).toHaveBeenCalledWith(-5678, "SIGTERM");
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it("respects the signal argument on both kill paths", () => {
      const kill = vi.fn(() => true);
      treeKill(fakeChild({ pid: 5678, kill }), "SIGKILL");
      expect(processKillSpy).toHaveBeenCalledWith(-5678, "SIGKILL");
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("falls back to child.kill when process-group kill ESRCHes (non-detached)", () => {
      processKillSpy.mockImplementation(() => {
        throw new Error("ESRCH");
      });
      const kill = vi.fn(() => true);
      expect(() => treeKill(fakeChild({ pid: 5678, kill }))).not.toThrow();
      expect(kill).toHaveBeenCalled();
    });
  });

  describe("guards", () => {
    beforeEach(() => setPlatform("win32"));

    it("no-ops when pid is undefined (spawn error)", () => {
      treeKill(fakeChild({ pid: undefined }));
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it("no-ops when child already exited", () => {
      treeKill(fakeChild({ pid: 1234, exitCode: 0 }));
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it("no-ops when child already signalled", () => {
      treeKill(fakeChild({ pid: 1234, signalCode: "SIGTERM" }));
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  // ─── treeKillPid — bare-pid overload (audit 2026-05-17) ──────────────────
  describe("treeKillPid", () => {
    afterEach(() => {
      setPlatform(ORIG_PLATFORM);
      execFileSyncMock.mockReset();
    });

    it("on win32 — invokes taskkill /F /T /PID <pid>", () => {
      setPlatform("win32");
      execFileSyncMock.mockImplementationOnce(() => Buffer.from(""));
      treeKillPid(4242);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "taskkill",
        ["/F", "/T", "/PID", "4242"],
        expect.objectContaining({ stdio: "ignore", windowsHide: true }),
      );
    });

    it("on win32 — swallows taskkill failure (process already exited)", () => {
      setPlatform("win32");
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error("not found");
      });
      // Must not throw — best-effort semantics.
      expect(() => treeKillPid(4242)).not.toThrow();
    });

    it("no-ops on invalid pid (0, NaN, negative)", () => {
      setPlatform("win32");
      treeKillPid(0);
      treeKillPid(-1);
      treeKillPid(Number.NaN);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it("on posix — does not call taskkill (process.kill is used)", () => {
      setPlatform("darwin");
      // process.kill(-pid) on an invalid pid throws; the helper swallows
      // so the call must complete without error.
      expect(() => treeKillPid(999_999_999)).not.toThrow();
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });
});
