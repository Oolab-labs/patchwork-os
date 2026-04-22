import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process");
vi.mock("node:fs");

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import {
  detectWorkspaceSymlinkInstall,
  SYMLINK_INSTALL_FIX,
} from "../installGuard.js";

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedRealpathSync = vi.mocked(realpathSync);

afterEach(() => {
  vi.clearAllMocks();
});

function makeStatResult(isSymLink: boolean) {
  return { isSymbolicLink: () => isSymLink } as ReturnType<typeof lstatSync>;
}

function mockNpmRoot(root: string) {
  mockedSpawnSync.mockReturnValue({
    stdout: `${root}\n`,
    stderr: "",
    status: 0,
    error: undefined,
    pid: 1,
    output: [],
    signal: null,
  });
}

describe("detectWorkspaceSymlinkInstall", () => {
  it("returns null when the global slot is a real directory (normal install)", () => {
    mockNpmRoot("/opt/homebrew/lib/node_modules");
    mockedLstatSync.mockReturnValue(makeStatResult(false));

    expect(detectWorkspaceSymlinkInstall()).toBeNull();
  });

  it("returns SymlinkInstallInfo when the global slot is a symlink to a workspace", () => {
    const globalRoot = "/opt/homebrew/lib/node_modules";
    const logicalRoot = `${globalRoot}/patchwork-os`;
    const realRoot = "/Users/wesh/Documents/Anthropic Workspace/Patchwork OS";

    mockNpmRoot(globalRoot);
    mockedLstatSync.mockReturnValue(makeStatResult(true));
    mockedRealpathSync.mockReturnValue(realRoot as unknown as string & Buffer);

    const result = detectWorkspaceSymlinkInstall();
    expect(result).toEqual({ logicalRoot, realRoot });
  });

  it("returns null when npm root command fails", () => {
    mockedSpawnSync.mockReturnValue({
      stdout: "",
      stderr: "npm: command not found",
      status: 1,
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    });

    expect(detectWorkspaceSymlinkInstall()).toBeNull();
  });

  it("returns null when npm spawnSync throws (npm not found)", () => {
    mockedSpawnSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(detectWorkspaceSymlinkInstall()).toBeNull();
  });

  it("returns null when lstatSync throws (slot does not exist)", () => {
    mockNpmRoot("/opt/homebrew/lib/node_modules");
    mockedLstatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(detectWorkspaceSymlinkInstall()).toBeNull();
  });

  it("returns null when npm returns empty stdout", () => {
    mockedSpawnSync.mockReturnValue({
      stdout: "",
      stderr: "",
      status: 0,
      error: undefined,
      pid: 1,
      output: [],
      signal: null,
    });

    expect(detectWorkspaceSymlinkInstall()).toBeNull();
  });

  it("SYMLINK_INSTALL_FIX contains tarball and registry instructions", () => {
    expect(SYMLINK_INSTALL_FIX).toContain("npm pack");
    expect(SYMLINK_INSTALL_FIX).toContain("npm install -g patchwork-os");
  });
});
