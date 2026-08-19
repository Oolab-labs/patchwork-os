/**
 * The scheduler's use of the cron claim (#1458) — the wiring, not the primitive.
 *
 * `cronClaimCrossProcess.test.ts` proves the claim excludes across real OS
 * processes. `cronClaim.test.ts` proves the primitive's own properties. Neither
 * proves that `fire()` actually consults it, or that it consults it in the
 * right ORDER, and a claim store nothing calls would leave every assertion in
 * both files true while the bug stayed exactly where it was. That is this file.
 *
 * Two schedulers here share a claims directory. In production they are two
 * processes; here they are two objects, which is enough to exercise the wiring
 * because the claim lives on the filesystem, and deliberately NOT presented as
 * evidence of cross-process atomicity — that is the other file's job.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchedSlotMs, RecipeScheduler } from "../scheduler.js";

let tmp: string;
let claimsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sched-claim-"));
  claimsDir = path.join(tmp, "claims");
  mkdirSync(path.join(tmp, "recipes"), { recursive: true });
  writeFileSync(
    path.join(tmp, "recipes", "beat.yaml"),
    [
      "name: beat",
      "description: fixture",
      "trigger:",
      "  type: cron",
      '  at: "7 * * * *"',
      "steps:",
      "  - id: noop",
      "    tool: file.read",
      "    params:",
      "      path: /dev/null",
      "",
    ].join("\n"),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SLOT = Date.parse("2026-08-19T08:07:00.000Z");

/**
 * A scheduler standing in for one bridge.
 *
 * `disabledRecipes: []` is injected rather than left to `loadConfig()` — the
 * scheduler reads the developer's real `~/.patchwork/config.json` otherwise,
 * and a fixture whose name collided with the dev box's disabled set would make
 * this file silently test nothing.
 */
function bridge(fired: string[]): RecipeScheduler {
  return new RecipeScheduler({
    recipesDir: path.join(tmp, "recipes"),
    enqueue: () => "tid",
    runYaml: async (name) => {
      fired.push(name);
    },
    disabledRecipes: [],
    claim: { claimsDir },
  });
}

describe("fire() consults the claim before dispatching", () => {
  it("the second bridge to reach a tick does not fire it", async () => {
    const firedA: string[] = [];
    const firedB: string[] = [];
    const a = bridge(firedA);
    const b = bridge(firedB);

    a.fireForTest("beat", SLOT);
    b.fireForTest("beat", SLOT);
    await new Promise((r) => setTimeout(r, 10));

    expect(firedA).toEqual(["beat"]);
    expect(firedB).toEqual([]); // claimed by A
  });

  it("a different tick of the same recipe still fires", async () => {
    const firedA: string[] = [];
    const firedB: string[] = [];
    bridge(firedA).fireForTest("beat", SLOT);
    bridge(firedB).fireForTest("beat", SLOT + 3_600_000);
    await new Promise((r) => setTimeout(r, 10));

    // The claim is on the TICK, not the recipe. A guard that blocked the next
    // hour's run would stop the recipe permanently after its first fire.
    expect(firedA).toEqual(["beat"]);
    expect(firedB).toEqual(["beat"]);
  });

  it("takes NO claim when there is no slot, so today's callers are unchanged", async () => {
    const firedA: string[] = [];
    const firedB: string[] = [];
    bridge(firedA).fireForTest("beat");
    bridge(firedB).fireForTest("beat");
    await new Promise((r) => setTimeout(r, 10));

    // `@every` intervals and the test hook have no canonical slot. Both fire,
    // exactly as before this change — the gap is announced in the log at
    // start(), not closed silently with a fabricated key.
    expect(firedA).toEqual(["beat"]);
    expect(firedB).toEqual(["beat"]);
  });
});

describe("the claim is taken LAST, after every local decision", () => {
  it("a bridge that has the recipe disabled does not burn the slot", async () => {
    const firedDisabled: string[] = [];
    const firedEnabled: string[] = [];

    const disabled = new RecipeScheduler({
      recipesDir: path.join(tmp, "recipes"),
      enqueue: () => "tid",
      runYaml: async (name) => {
        firedDisabled.push(name);
      },
      disabledRecipes: ["beat"],
      claim: { claimsDir },
    });

    disabled.fireForTest("beat", SLOT);
    bridge(firedEnabled).fireForTest("beat", SLOT);
    await new Promise((r) => setTimeout(r, 10));

    // If the claim came first, the disabled bridge would consume the tick and
    // then skip — and the recipe would run NOWHERE, on a configuration that
    // looks deliberate on both machines. This is the ordering bug the design
    // calls load-bearing, so it gets its own test rather than a comment.
    expect(firedDisabled).toEqual([]);
    expect(firedEnabled).toEqual(["beat"]);
  });
});

describe("degraded store", () => {
  /** A path that cannot be created: a FILE where the claims directory must go. */
  function unusable(): string {
    const p = path.join(tmp, "blocked");
    writeFileSync(p, "not a directory");
    return p;
  }

  it("fails OPEN — the tick fires and the log says so", async () => {
    const fired: string[] = [];
    const warnings: string[] = [];
    const s = new RecipeScheduler({
      recipesDir: path.join(tmp, "recipes"),
      enqueue: () => "tid",
      runYaml: async (name) => {
        fired.push(name);
      },
      disabledRecipes: [],
      claim: { claimsDir: unusable() },
      logger: {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        error: () => {},
        debug: () => {},
      } as never,
    });

    s.fireForTest("beat", SLOT);
    await new Promise((r) => setTimeout(r, 10));

    expect(fired).toEqual(["beat"]);
    // Never silently. A duplicate nobody was warned about is the failure mode
    // fail-open trades for, and it is only an acceptable trade if it is loud.
    expect(warnings.join("\n")).toMatch(/claim store unusable/i);
    expect(warnings.join("\n")).toMatch(/PATCHWORK_CRON_CLAIM_REQUIRED/);
  });

  it("fails CLOSED when the operator asks, and says which happened", async () => {
    const fired: string[] = [];
    const warnings: string[] = [];
    const s = new RecipeScheduler({
      recipesDir: path.join(tmp, "recipes"),
      enqueue: () => "tid",
      runYaml: async (name) => {
        fired.push(name);
      },
      disabledRecipes: [],
      claim: { claimsDir: unusable(), required: true },
      logger: {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        error: () => {},
        debug: () => {},
      } as never,
    });

    s.fireForTest("beat", SLOT);
    await new Promise((r) => setTimeout(r, 10));

    expect(fired).toEqual([]);
    // "a peer has it" and "we could not tell" call for opposite responses, so
    // the log must not render them the same way.
    expect(warnings.join("\n")).toMatch(/NOT firing/);
  });
});

describe("matchedSlotMs", () => {
  it("floors the matched instant to its second", () => {
    expect(matchedSlotMs({ date: new Date(SLOT + 999) })).toBe(SLOT);
  });

  it("returns undefined for a context that carries no usable date", () => {
    // A node-cron that stops passing a context must degrade to today's
    // behaviour — no slot, no claim, both bridges fire — rather than throw
    // inside a timer callback, where nothing would catch it.
    expect(matchedSlotMs(undefined)).toBeUndefined();
    expect(matchedSlotMs({})).toBeUndefined();
    expect(matchedSlotMs({ date: new Date(Number.NaN) })).toBeUndefined();
  });
});

describe("a REAL cron tick, end to end", () => {
  it("two schedulers on one expression fire each second once between them", async () => {
    // The join nothing else covers: cron.schedule's callback -> matchedSlotMs
    // -> fire(slot) -> claim. Every other test in this file drives fire()
    // directly, so a wiring bug here — reading `triggeredAt` instead of
    // `date`, say, which differs per process by exactly the amount that
    // breaks the key — would leave all of them green.
    const dir = path.join(tmp, "recipes-fast");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "tick.yaml"),
      [
        "name: tick",
        "description: fixture",
        "trigger:",
        "  type: cron",
        '  at: "* * * * * *"',
        "steps:",
        "  - id: noop",
        "    tool: file.read",
        "    params:",
        "      path: /dev/null",
        "",
      ].join("\n"),
    );

    const fires: number[] = [];
    const make = () =>
      new RecipeScheduler({
        recipesDir: dir,
        enqueue: () => "tid",
        runYaml: async () => {
          fires.push(Date.now());
        },
        disabledRecipes: [],
        claim: { claimsDir },
      });

    const a = make();
    const b = make();
    a.start();
    b.start();
    await new Promise((r) => setTimeout(r, 4200));
    a.stop();
    b.stop();

    const seconds = new Set(fires.map((t) => Math.floor(t / 1000)));

    // Guard against the green-because-nothing-ran trap FIRST.
    expect(seconds.size).toBeGreaterThanOrEqual(2);
    // Two schedulers, one expression: without the claim this is ~2 per
    // second. With it, at most one.
    expect(fires.length).toBe(seconds.size);
  }, 30_000);
});
