import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSubprocessSettings } from "../subprocessSettings.js";

const log = vi.fn();

function writtenDenyList(): string[] {
  const { path, write } = createSubprocessSettings(log);
  write();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      permissions?: { deny?: string[] };
    };
    return parsed.permissions?.deny ?? [];
  } finally {
    rmSync(path, { force: true });
  }
}

describe("createSubprocessSettings deny list", () => {
  it("writes a settings file with a permissions.deny list", () => {
    const deny = writtenDenyList();
    expect(Array.isArray(deny)).toBe(true);
    expect(deny.length).toBeGreaterThan(0);
  });

  // drivers-orch-5 regression: reversed-flag and missing-flag rm/git-clean
  // variants must be blocked. Claude Code matches the literal argument string,
  // so `rm -fr`, `rm -r`, `git clean -d` are distinct patterns from the
  // originally-listed `rm -rf` / `git clean -f`.
  it("blocks reversed and missing-flag rm variants and git clean -d/--force", () => {
    const deny = writtenDenyList();
    for (const pattern of [
      "Bash(rm -rf *)",
      "Bash(rm -fr *)",
      "Bash(rm -r *)",
      "Bash(rm --recursive*)",
      "Bash(git clean -f*)",
      "Bash(git clean -d*)",
      "Bash(git clean --force*)",
    ]) {
      expect(deny).toContain(pattern);
    }
  });
});
