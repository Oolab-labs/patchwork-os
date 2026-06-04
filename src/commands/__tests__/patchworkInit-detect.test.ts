/**
 * Unit tests for detectGrokCli — the Grok Build (Grok CLI) detection used by
 * `patchwork init`. Probes `grok --version`, then falls back to the path the
 * official installer symlinks (~/.grok/bin/grok) when the binary isn't on PATH.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

import { detectGrokCli } from "../patchworkInit.js";

const mockSpawn = vi.mocked(spawnSync);

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-detect-"));
  mockSpawn.mockReset();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("detectGrokCli", () => {
  it("returns true when `grok --version` exits 0", () => {
    mockSpawn.mockReturnValue({ status: 0 } as never);
    expect(detectGrokCli(home)).toBe(true);
  });

  it("falls back to ~/.grok/bin/grok when the binary isn't on PATH", () => {
    mockSpawn.mockReturnValue({ status: 1 } as never);
    fs.mkdirSync(path.join(home, ".grok", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".grok", "bin", "grok"), "");
    expect(detectGrokCli(home)).toBe(true);
  });

  it("returns false when neither the binary nor ~/.grok/bin/grok is present", () => {
    mockSpawn.mockReturnValue({ status: 1 } as never);
    expect(detectGrokCli(home)).toBe(false);
  });

  it("returns false (does not throw) when spawnSync throws", () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(detectGrokCli(home)).toBe(false);
  });
});
