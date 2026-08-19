/**
 * The only test here that can tell the fix from the bug (#1458).
 *
 * ## Why the single-process tests are not enough, stated first
 *
 * #1458 is that N *operating-system processes* each fire the same cron tick,
 * because the guard is an in-memory `Set` and a `Set` cannot see a sibling
 * process. A test that constructs two claimants inside one Node process shares
 * a module graph, a heap and a clock — it would pass just as happily against a
 * three-line in-memory `Map` keyed by slot, which has no cross-process
 * behaviour whatsoever and fixes nothing.
 *
 * So the claimants here are real `node` processes, spawned concurrently and
 * released together by a barrier so they genuinely contend for the same slot.
 *
 * ## The two ways this could pass while proving nothing, and what stops each
 *
 * **Children that never ran.** "Exactly one claimed" is also true when seven of
 * eight crashed on startup. Every child's verdict is collected and the count is
 * asserted, so a child that failed to start fails the test rather than
 * flattering it.
 *
 * **Children that did not contend.** Spawning is slow and jittery enough that
 * eight sequential-ish starts could each find the slot free in turn only if the
 * primitive were broken — but they might also simply not overlap. Each child
 * signals readiness and then spins until a `go` file appears, so the claims are
 * issued inside the same few milliseconds.
 *
 * The mutation that proves this test bites: degrade `claimCronSlot` from
 * `openSync(path, "wx")` to `existsSync` + `writeFileSync`. That is the single
 * most likely future "simplification", it passes every unit test in
 * `cronClaim.test.ts`, and it turns this file red.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cronClaimKey } from "../cronClaim.js";

/** Absolute path to the module under test, handed to the children. */
const MODULE_UNDER_TEST = fileURLToPath(
  new URL("../cronClaim.ts", import.meta.url),
);

/**
 * Children run TypeScript directly through `tsx` (a declared devDependency and
 * already this repo's `dev` script). Compiling to `dist/` first would work too
 * and was rejected: it makes the test depend on a build step, and a stale
 * `dist/` would silently test yesterday's code — the exact class of mistake
 * `patchwork doctor` exists for.
 */
const TSX_LOADER = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(os.tmpdir(), "cron-claim-xproc-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Source for one claimant. Written to disk so `tsx` can load it as a module. */
function childSource(): string {
  return `
import { existsSync, writeFileSync } from "node:fs";
const [modulePath, claimsDir, recipe, slot, readyFile, goFile] = process.argv.slice(2);
const { claimCronSlot } = await import(modulePath);
writeFileSync(readyFile, "ready");
// Spin — not sleep. The window we are trying to land inside is milliseconds
// wide, and a timer would round us straight past it.
while (!existsSync(goFile)) { /* barrier */ }
const r = claimCronSlot(recipe, Number(slot), { claimsDir });
process.stdout.write(r.kind + "\\n");
`;
}

/**
 * Spawn `n` claimants for one slot and return what each decided.
 *
 * Deliberately returns every verdict, including failures, so the assertions can
 * distinguish "one claimed and the rest were told it was taken" from "one
 * claimed and the rest died".
 */
async function raceForSlot(
  n: number,
  recipe: string,
  slot: number,
): Promise<string[]> {
  const claimsDir = join(root, "claims");
  const goFile = join(root, `go-${slot}`);
  const children: Promise<string>[] = [];
  const readyFiles: string[] = [];

  const childFile = join(root, "claimant.mts");
  writeFileSync(childFile, childSource());

  for (let i = 0; i < n; i++) {
    const readyFile = join(root, `ready-${slot}-${i}`);
    readyFiles.push(readyFile);
    children.push(
      new Promise<string>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            TSX_LOADER,
            childFile,
            MODULE_UNDER_TEST,
            claimsDir,
            recipe,
            String(slot),
            readyFile,
            goFile,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += String(d);
        });
        child.stderr.on("data", (d) => {
          err += String(d);
        });
        child.on("close", (code) => {
          const verdict = out.trim();
          // A dead child reports as such rather than vanishing. Silence here is
          // what would let this test pass for the wrong reason.
          resolve(verdict || `DIED(code=${code}) ${err.trim().slice(0, 200)}`);
        });
      }),
    );
  }

  // Release only once every child is parked on the barrier.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (readyFiles.every((f) => existsSync(f))) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  writeFileSync(goFile, "go");

  return Promise.all(children);
}

describe("two operating-system processes cannot both claim one tick", () => {
  it("exactly one of eight concurrent claimants wins, and all eight report", async () => {
    const slot = Date.parse("2026-08-19T08:07:00.000Z");
    const verdicts = await raceForSlot(8, "heartbeat", slot);

    // Assert this FIRST: a run where seven children died would otherwise
    // satisfy "exactly one claimed" while proving the opposite of the point.
    expect(verdicts).toHaveLength(8);
    expect(verdicts.filter((v) => v.startsWith("DIED"))).toEqual([]);

    expect(verdicts.filter((v) => v === "claimed")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "taken")).toHaveLength(7);
  }, 60_000);

  it("the winner leaves exactly one claim file, under the key the module derives", async () => {
    const slot = Date.parse("2026-08-19T09:07:00.000Z");
    const verdicts = await raceForSlot(4, "heartbeat", slot);
    expect(verdicts.filter((v) => v === "claimed")).toHaveLength(1);

    // Guards against a claim that is written somewhere while the decision is
    // made from something else entirely.
    const day = join(root, "claims", "2026-08-19");
    expect(readdirSync(day)).toEqual([
      `${cronClaimKey("heartbeat", slot)}.json`,
    ]);
  }, 60_000);

  it("different slots do not contend — a later tick is still allowed to fire", async () => {
    const a = Date.parse("2026-08-19T10:07:00.000Z");
    const b = Date.parse("2026-08-19T11:07:00.000Z");
    expect(
      (await raceForSlot(3, "heartbeat", a)).filter((v) => v === "claimed"),
    ).toHaveLength(1);
    expect(
      (await raceForSlot(3, "heartbeat", b)).filter((v) => v === "claimed"),
    ).toHaveLength(1);
  }, 60_000);

  it("tsx is present, so a skipped child would not read as a pass", () => {
    // If the loader were missing every child would die, and the assertions
    // above already catch that — but they would report it as a claim failure
    // rather than as a missing test dependency. This says which.
    expect(existsSync(TSX_LOADER)).toBe(true);
    expect(() =>
      execFileSync(process.execPath, ["--import", TSX_LOADER, "-e", "0"], {
        stdio: "ignore",
      }),
    ).not.toThrow();
  });
});
