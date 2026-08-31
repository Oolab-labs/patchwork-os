import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The verb is reachable, and the exit code is the contract.
 *
 * `doctor` spent its whole life with two top-level `argv[2]` handlers, one of
 * which never ran: the logic was proven by tests that called it directly, and
 * the WIRING was never exercised by anything. These tests spawn the built CLI
 * for that reason — a unit test on `diffReadings` cannot see a shadowed case,
 * and `patchwork sweep && …` is a shape an operator will write.
 */
const distIndex = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../../dist/index.js",
);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pw-sweepcli-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sweep(args: string[]) {
  return spawnSync(process.execPath, [distIndex, "sweep", ...args], {
    encoding: "utf8",
  });
}

describe("patchwork sweep dispatch", () => {
  it("is reachable and not shadowed by another argv handler", () => {
    const r = sweep(["--help"]);
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(
      "What MOVED since the last sweep",
    );
  });

  it("exits 0 on a first run and says BASELINE, not 'nothing changed'", () => {
    const r = sweep(["--dir", tmp()]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BASELINE");
    expect(r.stdout).not.toContain("No counter moved");
  });

  it("exits 0 on a second run with no regression", () => {
    const d = tmp();
    expect(sweep(["--dir", d]).status).toBe(0);
    const second = sweep(["--dir", d]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("No gate regressed");
  });

  it("rejects a non-integer --expect-running rather than guessing", () => {
    const r = sweep(["--dir", tmp(), "--expect-running", "-3"]);
    expect(r.status).toBe(2);
  });

  it("--no-write leaves the next run still without a baseline", () => {
    const d = tmp();
    expect(sweep(["--dir", d, "--no-write"]).stdout).toContain("BASELINE");
    expect(sweep(["--dir", d, "--no-write"]).stdout).toContain("BASELINE");
  });

  it("emits a reading and a delta under --json", () => {
    const r = sweep(["--dir", tmp(), "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.delta.baseline).toBe(true);
    expect(typeof parsed.reading.takenAt).toBe("number");
    expect(parsed.reading.rv).toBe(1);
  });
});
