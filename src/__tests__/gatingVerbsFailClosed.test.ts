/**
 * The verbs whose EXIT CODE people script against must refuse a flag they do
 * not understand (audit 2026-10-15, M35).
 *
 * `rejectUnknownArgs` guarded exactly one verb, `evidence`. Every other gate —
 * `doctor`, `doctor health`, `doctor acceptance`, `sweep`, `workers list`,
 * `workers validate`, `workers authority-delta` — accepted a typo and exited
 * on its normal result. `patchwork doctor --expect-runing 2 && echo deployed`
 * printed "deployed" after checking nothing about the expectation. A green
 * result from a command that ignored what it was asked is the failure this
 * guard exists for.
 *
 * Drives the built CLI (`dist/index.js`) with PATCHWORK_HOME in a temp dir.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejectUnknownArgs, UNRECOGNISED_EXIT } from "../cliArgs.js";

const DIST = path.resolve(import.meta.dirname, "../../dist/index.js");
let home = "";
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-gating-flags-"));
});
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [DIST, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATCHWORK_HOME: home },
    timeout: 120_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("optionalValueFlags", () => {
  const base = { command: "x", flags: ["--json"], exit: false as const };
  it("consumes a following value when one is given", () => {
    expect(
      rejectUnknownArgs({
        ...base,
        args: ["--expect-running", "2", "--json"],
        optionalValueFlags: ["--expect-running"],
      }),
    ).toBeNull();
  });
  it("does not swallow a following FLAG as its value", () => {
    expect(
      rejectUnknownArgs({
        ...base,
        args: ["--expect-running", "--bogus"],
        optionalValueFlags: ["--expect-running"],
      })?.message,
    ).toContain("--bogus");
  });
  it("is fine bare, at the end", () => {
    expect(
      rejectUnknownArgs({
        ...base,
        args: ["--json", "--expect-running"],
        optionalValueFlags: ["--expect-running"],
      }),
    ).toBeNull();
  });
});

const TYPOS: Array<{ label: string; args: string[] }> = [
  { label: "doctor", args: ["doctor", "--expect-runing", "2"] },
  { label: "doctor health", args: ["doctor", "health", "--jsn"] },
  { label: "doctor acceptance", args: ["doctor", "acceptance", "--jsonn"] },
  { label: "sweep", args: ["sweep", "--no-wrte"] },
  { label: "workers list", args: ["workers", "list", "--worker-dir", "x"] },
  {
    label: "workers validate",
    args: ["workers", "validate", "--recipe-dir", "x"],
  },
  {
    label: "workers authority-delta",
    args: ["workers", "authority-delta", "--bse", "main"],
  },
];

describe.skipIf(!existsSync(DIST))(
  "a mistyped flag on a gating verb is refused",
  () => {
    for (const t of TYPOS) {
      it(`${t.label}: exits ${UNRECOGNISED_EXIT}, names the flag, runs nothing`, () => {
        const r = run(...t.args);
        expect(r.status, r.out).toBe(UNRECOGNISED_EXIT);
        expect(r.out).toContain("unrecognised");
        expect(r.out).toContain("Nothing was run");
      });
    }
  },
);

const ACCEPTED: Array<{ label: string; args: string[] }> = [
  {
    label: "doctor bare --expect-running",
    args: ["doctor", "--expect-running", "--json"],
  },
  {
    label: "doctor --expect-running N",
    args: ["doctor", "--expect-running", "0", "--json"],
  },
  {
    label: "doctor --require-governed",
    args: ["doctor", "--require-governed", "--json"],
  },
  {
    label: "doctor health",
    args: ["doctor", "health", "--port", "1", "--json"],
  },
  {
    label: "sweep",
    args: [
      "sweep",
      "--no-write",
      "--dir",
      ".",
      "--expect-running",
      "0",
      "--json",
    ],
  },
  {
    label: "workers list",
    args: ["workers", "list", "--workers-dir", ".", "--json"],
  },
  {
    label: "workers validate",
    args: [
      "workers",
      "validate",
      "--workers-dir",
      ".",
      "--recipes-dir",
      ".",
      "--templates-dir",
      ".",
      "--json",
    ],
  },
];

describe.skipIf(!existsSync(DIST))(
  "controls — documented forms still get past the guard",
  () => {
    for (const t of ACCEPTED) {
      it(`${t.label}`, () => {
        const r = run(...t.args);
        expect(r.status, r.out).not.toBe(UNRECOGNISED_EXIT);
        expect(r.out).not.toContain("unrecognised");
      });
    }
  },
);
