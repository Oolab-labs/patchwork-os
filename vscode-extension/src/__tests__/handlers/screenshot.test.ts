import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCaptureScreenshot } from "../../handlers/screenshot";

// Mock node:child_process and node:fs for all tests
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockReadFileSync = vi.mocked(fs.readFileSync);

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
    mockReadFileSync.mockReturnValue(fakeBuffer as unknown as string);

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
    mockReadFileSync.mockReturnValue(fakeBuffer as unknown as string);

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
});
