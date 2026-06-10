/**
 * Audit 2026-06-10 cli-commands-1 regression test.
 *
 * `status --port <arg>` fed `<arg>` straight into path.join(lockDir,
 * `${arg}.lock`) with no validation. path.join does not block traversal, so
 * `--port ../../../etc/secret` resolved outside the lock dir and could read +
 * print an arbitrary `*.lock` file's JSON contents. The fix validates the port
 * is a 1–65535 integer before constructing the path.
 *
 * Runs the real CLI via tsx as a subprocess (src/index.ts is a top-of-script
 * executable that can't be imported without running its dispatch side effects).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const indexTs = path.join(repoRoot, "src", "index.ts");

function runStatus(portArg: string): { code: number; stderr: string } {
  const res = spawnSync(tsxBin, [indexTs, "status", "--port", portArg], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: res.status ?? -1, stderr: `${res.stderr}${res.stdout}` };
}

describe("cli-commands-1 — status --port input validation", () => {
  it("rejects a path-traversal --port value", () => {
    const { code, stderr } = runStatus("../../../etc/secret");
    expect(code).toBe(1);
    expect(stderr).toMatch(/must be a valid port number/);
    // Must NOT have attempted to read a traversed lock file path.
    expect(stderr).not.toMatch(/No lock file found/);
  });

  it("rejects port 0", () => {
    const { code, stderr } = runStatus("0");
    expect(code).toBe(1);
    expect(stderr).toMatch(/must be a valid port number/);
  });

  it("rejects an out-of-range port", () => {
    const { code, stderr } = runStatus("99999");
    expect(code).toBe(1);
    expect(stderr).toMatch(/must be a valid port number/);
  });

  it("accepts a syntactically valid port (then fails on the missing lock, not on validation)", () => {
    const { code, stderr } = runStatus("65535");
    expect(code).toBe(1);
    // Passed validation → reached the lock-file existence check.
    expect(stderr).toMatch(/No lock file found/);
    expect(stderr).not.toMatch(/must be a valid port number/);
  });
});
