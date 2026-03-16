import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCaptureScreenshot } from "../../handlers/screenshot";

// Mock node:child_process and node:fs/promises for all tests
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import * as childProcess from "node:child_process";
import * as fsp from "node:fs/promises";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockReadFile = vi.mocked(fsp.readFile);

function makeSpawnMock(exitCode: number, errorEvent?: Error) {
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const proc = {
    on: (event: string, cb: (arg: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      // Emit asynchronously
      if (event === "close" && errorEvent === undefined) {
        Promise.resolve().then(() => cb(exitCode));
      }
      if (event === "error" && errorEvent !== undefined) {
        Promise.resolve().then(() => cb(errorEvent));
      }
    },
  };
  return proc as unknown as ReturnType<typeof childProcess.spawn>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleCaptureScreenshot", () => {
  it("returns base64 image data on macOS success", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    const fakeBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    mockSpawn.mockReturnValue(makeSpawnMock(0));
    mockReadFile.mockResolvedValue(fakeBuffer as unknown as string);

    const result = (await handleCaptureScreenshot()) as {
      base64: string;
      mimeType: string;
    };
    expect(result.mimeType).toBe("image/png");
    expect(result.base64).toBe(fakeBuffer.toString("base64"));

    // screencapture called with -x flag
    expect(mockSpawn).toHaveBeenCalledWith(
      "screencapture",
      expect.arrayContaining(["-x"]),
    );

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("uses unique tmp file per call — concurrent calls get distinct paths", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    const fakeBuffer = Buffer.from("fake-png");
    mockSpawn.mockReturnValue(makeSpawnMock(0));
    mockReadFile.mockResolvedValue(fakeBuffer as unknown as string);

    const capturedArgs: string[][] = [];
    mockSpawn.mockImplementation((_cmd, args) => {
      capturedArgs.push(args as string[]);
      return makeSpawnMock(0);
    });

    await Promise.all([handleCaptureScreenshot(), handleCaptureScreenshot()]);

    const paths = capturedArgs.map((a) => a[a.length - 1] as string);
    expect(paths[0]).not.toBe(paths[1]);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("rejects when spawn exits with non-zero code", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    mockSpawn.mockReturnValue(makeSpawnMock(1));

    await expect(handleCaptureScreenshot()).rejects.toThrow("code 1");

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("rejects when spawn emits an error event", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    const spawnError = new Error("screencapture not found");
    mockSpawn.mockReturnValue(makeSpawnMock(0, spawnError));

    await expect(handleCaptureScreenshot()).rejects.toThrow(
      "screencapture not found",
    );

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("rejects with unsupported platform message on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    await expect(handleCaptureScreenshot()).rejects.toThrow(
      "not supported on platform: win32",
    );

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("uses ImageMagick import on Linux", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    const fakeBuffer = Buffer.from("fake-png");
    mockSpawn.mockReturnValue(makeSpawnMock(0));
    mockReadFile.mockResolvedValue(fakeBuffer as unknown as string);

    await handleCaptureScreenshot();

    expect(mockSpawn).toHaveBeenCalledWith(
      "import",
      expect.arrayContaining(["-window", "root"]),
    );

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("retries readFile up to 3 times on transient ENOENT before succeeding", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    const fakeBuffer = Buffer.from("retry-success");
    mockSpawn.mockReturnValue(makeSpawnMock(0));
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile
      .mockRejectedValueOnce(enoent)
      .mockResolvedValue(fakeBuffer as unknown as string);

    const result = (await handleCaptureScreenshot()) as {
      base64: string;
    };
    expect(result.base64).toBe(fakeBuffer.toString("base64"));
    expect(mockReadFile).toHaveBeenCalledTimes(2);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("rejects after all retries fail", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    mockSpawn.mockReturnValue(makeSpawnMock(0));
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile.mockRejectedValue(enoent);

    await expect(handleCaptureScreenshot()).rejects.toThrow("ENOENT");
    expect(mockReadFile).toHaveBeenCalledTimes(3);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });
});
