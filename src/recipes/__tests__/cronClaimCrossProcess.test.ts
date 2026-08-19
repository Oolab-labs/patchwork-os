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
 * So the claimants here are real `node` processes, released together by a
 * barrier so they genuinely contend for the same slot.
 *
 * The mutation that proves this file bites: degrade `claimCronSlot` from
 * `openSync(path, "wx")` to `existsSync` + `writeFileSync`. That is the single
 * most likely future "simplification", it passes every test in
 * `cronClaim.test.ts`, and it turns this one red.
 *
 * ## How the children load the module, and why it is done the hard way
 *
 * The module is bundled to a plain `.mjs` with esbuild into the same temp
 * directory as the child script, which imports it by a RELATIVE specifier. The
 * children then start as `node claimant.mjs` — no `--import`, no loader flag,
 * no absolute path crossing a process boundary, nothing for two platforms to
 * resolve differently.
 *
 * The obvious version was `node --import tsx claimant.ts`. It cost 225 seconds
 * of Windows CI before being abandoned, and paid for two lessons worth keeping:
 *
 *   - `--import` takes an ESM specifier, not a path. On POSIX a bare absolute
 *     path happens to resolve; on Windows a leading `D:` parses as a URL
 *     scheme. A test can be green on the machine that wrote it and structurally
 *     broken on the one that matters.
 *   - Every thing a child has to resolve is a chance for the platforms to
 *     disagree. Bundling removes the resolution rather than fixing it.
 *
 * Importing `dist/` was also rejected: it would make this depend on a build
 * step, and a stale `dist/` would silently test yesterday's code — the exact
 * mistake `patchwork doctor` exists for. The bundle is produced from the
 * current source, in this process, on every run.
 *
 * ## Diagnosing a failure from CI
 *
 * A child's stderr is carried into its verdict string and asserted with
 * `.toBe("")` rather than `.toEqual([])`, so the message names what actually
 * went wrong. That matters more than it looks: the Test step's console log is
 * truncated by GitHub well before vitest's summary, so an assertion printing
 * only "expected [] to have length 4" is unreadable from CI. The
 * `vitest-progress-reporter` artifact tells you WHICH module died; this
 * assertion has to tell you WHY.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cronClaimKey } from "../cronClaim.js";

const MODULE_UNDER_TEST = fileURLToPath(
  new URL("../cronClaim.ts", import.meta.url),
);

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(os.tmpdir(), "cron-claim-xproc-"));
  mkdirSync(join(root, "claims"), { recursive: true });

  // Bundled per test, from the current source. A cached artifact would hide
  // exactly the change this file exists to catch.
  await build({
    entryPoints: [MODULE_UNDER_TEST],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(root, "cronClaim.mjs"),
    logLevel: "silent",
  });

  writeFileSync(
    join(root, "claimant.mjs"),
    `
import { existsSync, writeFileSync } from "node:fs";
import { claimCronSlot } from "./cronClaim.mjs";
const [claimsDir, recipe, slot, readyFile, goFile] = process.argv.slice(2);
writeFileSync(readyFile, "ready");
// Poll, do not busy-spin. Four processes each pinning a core on a two-core CI
// runner starves the very scheduling this test depends on. 1 ms is far tighter
// than needed: openSync(..., "wx") is atomic, so the barrier only has to stop
// the children arriving SECONDS apart, not microseconds.
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 1));
process.stdout.write(claimCronSlot(recipe, Number(slot), { claimsDir }).kind + "\\n");
`,
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Spawn `n` claimants for one slot and return what each decided.
 *
 * Returns EVERY verdict, including failures. "Exactly one claimed" is also true
 * when the other three died on startup, so the caller must be able to tell
 * those apart — silence here is what would let this test pass for the wrong
 * reason.
 */
async function raceForSlot(
  n: number,
  recipe: string,
  slot: number,
): Promise<string[]> {
  const claimsDir = join(root, "claims");
  const goFile = join(root, `go-${slot}`);
  const readyFiles: string[] = [];
  let exited = 0;

  const children = Array.from({ length: n }, (_, i) => {
    const readyFile = join(root, `ready-${slot}-${i}`);
    readyFiles.push(readyFile);
    return new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          join(root, "claimant.mjs"),
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
      child.on("error", (e) => {
        exited++;
        resolve(`DIED(spawn) ${e.message}`);
      });
      child.on("close", (code) => {
        exited++;
        resolve(out.trim() || `DIED(code=${code}) ${err.trim().slice(0, 400)}`);
      });
    });
  });

  // Release once every child is parked — or once they have all EXITED, which is
  // what a startup failure looks like. Waiting out the full deadline in that
  // case turns one broken child into a per-test timeout, and a suite that reads
  // as hung rather than as failed. That cost 225 s of Windows CI once already.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readyFiles.every((f) => existsSync(f))) break;
    if (exited === n) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(goFile, "go");

  return Promise.all(children);
}

describe("two operating-system processes cannot both claim one tick", () => {
  it("exactly one of four concurrent claimants wins, and all four report", async () => {
    const slot = Date.parse("2026-08-19T08:07:00.000Z");
    const verdicts = await raceForSlot(4, "heartbeat", slot);

    // Asserted FIRST, and as a STRING carrying the child's stderr. A run
    // where three children died would otherwise satisfy "exactly one claimed"
    // while proving the opposite of the point — and an array-length assertion
    // would give whoever debugs it from CI nothing to go on.
    expect(verdicts.filter((v) => v.startsWith("DIED")).join("\n")).toBe("");
    expect(verdicts).toHaveLength(4);

    expect(verdicts.filter((v) => v === "claimed")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "taken")).toHaveLength(3);
  }, 45_000);

  it("the winner leaves exactly one claim file, under the key the module derives", async () => {
    const slot = Date.parse("2026-08-19T09:07:00.000Z");
    const verdicts = await raceForSlot(3, "heartbeat", slot);

    expect(verdicts.filter((v) => v.startsWith("DIED")).join("\n")).toBe("");
    expect(verdicts.filter((v) => v === "claimed")).toHaveLength(1);

    // Guards against a claim written in one place while the decision is made
    // from another.
    const day = join(root, "claims", "2026-08-19");
    expect(readdirSync(day)).toEqual([
      `${cronClaimKey("heartbeat", slot)}.json`,
    ]);
  }, 45_000);

  // "different slots do not contend" is deliberately NOT re-tested here. It has
  // no cross-process content, `cronClaim.test.ts` covers it in-process, and it
  // cost six more node processes. Spending Windows CI wall-clock on a property
  // that does not need processes is how a correct test becomes a flake nobody
  // trusts.
});
