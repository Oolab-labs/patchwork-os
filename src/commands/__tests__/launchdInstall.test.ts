/**
 * Behaviour test: runLaunchdInstall fails early and clearly when a workspace
 * symlink install is detected, and succeeds when the install is a real copy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { PATCHWORK_PACKAGE_NAME } = vi.hoisted(() => ({
  PATCHWORK_PACKAGE_NAME: "patchwork-os",
}));

// Mock installGuard before importing the command under test.
vi.mock("../../installGuard.js", () => ({
  PATCHWORK_PACKAGE_NAME,
  detectWorkspaceSymlinkInstall: vi.fn(),
  SYMLINK_INSTALL_FIX:
    `  Fix: npm pack && npm install -g ${PATCHWORK_PACKAGE_NAME}-*.tgz\n` +
    `  Or install from the registry: npm install -g ${PATCHWORK_PACKAGE_NAME}\n`,
}));

// Mock all platform-specific side effects so the test is safe on Linux/CI.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi
    .fn()
    .mockReturnValue({ error: null, stdout: "/usr/local/bin/patchwork-os\n" }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // existsSync: true for template path so plistTemplate() doesn't throw;
    // false for plist destination so we skip the unload step.
    existsSync: vi
      .fn()
      .mockImplementation((p: unknown) => String(p).includes("templates")),
    mkdirSync: vi.fn(),
    readFileSync: vi
      .fn()
      .mockReturnValue("<plist>__BINARY_PATH__ __HOME__</plist>"),
    writeFileSync: vi.fn(),
  };
});

import { detectWorkspaceSymlinkInstall } from "../../installGuard.js";
import { runLaunchdInstall } from "../launchd.js";

const mockedDetect = vi.mocked(detectWorkspaceSymlinkInstall);

afterEach(() => {
  vi.clearAllMocks();
});

describe("runLaunchdInstall — symlink guard", () => {
  it("exits with code 1 and prints actionable error when install is a workspace symlink", async () => {
    // Simulate macOS
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    mockedDetect.mockReturnValue({
      logicalRoot: "/opt/homebrew/lib/node_modules/patchwork-os",
      realRoot: "/Users/wesh/Documents/Anthropic Workspace/Patchwork OS",
    });

    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error("process.exit");
      });

    await expect(runLaunchdInstall([])).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stderrChunks.join("");
    expect(output).toContain(
      `detected a symlinked global ${PATCHWORK_PACKAGE_NAME} install`,
    );
    expect(output).toContain(
      `/opt/homebrew/lib/node_modules/${PATCHWORK_PACKAGE_NAME}`,
    );
    expect(output).toContain(
      "/Users/wesh/Documents/Anthropic Workspace/Patchwork OS",
    );
    expect(output).toContain("npm pack");
    expect(output).toContain("launchd install");

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("proceeds normally (no exit) when install is a real copy", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    mockedDetect.mockReturnValue(null);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runLaunchdInstall([])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("installed as launchd agent");

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });
});
