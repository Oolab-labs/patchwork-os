/**
 * #1463 — the legacy-JSON cron path had no guard of any kind.
 *
 * `fire()` resolves a YAML path first, and BOTH protections — the per-recipe
 * in-flight guard (audit 2026-05-17) and the cross-process claim (#1461) — sat
 * inside the `if (yamlPath) {` branch. The JSON branch is reached only when
 * `yamlPath` is null and dispatches through a second call site that touched
 * neither.
 *
 * It never surfaced because every installed cron recipe is YAML, so nothing
 * exercises the legacy path. That makes it latent rather than live, and it also
 * means this fix can only ever be validated against a fixture — there is no
 * real traffic to check it against. Stated because "verified in production" is
 * not available here and pretending otherwise would be the more comfortable
 * lie.
 *
 * The danger is a reader's inference: after #1461 the scheduler looks like the
 * cron path is covered. It is covered FOR YAML. The next person to install a
 * JSON cron recipe would get both defects at once, on the path whose runs are
 * the ones stamped `cron:` in the run log — the first place a reviewer looks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecipeScheduler } from "../scheduler.js";

let tmp: string;
let claimsDir: string;
let recipesDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sched-json-"));
  claimsDir = path.join(tmp, "claims");
  recipesDir = path.join(tmp, "recipes");
  mkdirSync(recipesDir, { recursive: true });
  // A legacy JSON recipe — no YAML sibling, so `findYamlRecipePath` returns
  // null and `fire()` takes the branch under test.
  writeFileSync(
    path.join(recipesDir, "legacy.json"),
    JSON.stringify({
      name: "legacy",
      description: "fixture",
      steps: [{ id: "s1", prompt: "do the thing" }],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SLOT = Date.parse("2026-08-19T08:07:00.000Z");

function bridge(enqueued: string[]): RecipeScheduler {
  return new RecipeScheduler({
    recipesDir,
    enqueue: ({ triggerSource }) => {
      enqueued.push(triggerSource);
      return "tid";
    },
    // No runYaml on purpose: this path must not need one, and wiring one would
    // hide a mistake that sent a JSON recipe down the YAML branch.
    disabledRecipes: [],
    claim: { claimsDir },
  });
}

describe("#1463: the legacy JSON cron path honours the cross-process claim", () => {
  it("fires when it wins the slot", async () => {
    const enqueued: string[] = [];
    bridge(enqueued).fireForTest("legacy", SLOT);
    expect(enqueued).toEqual(["cron:legacy"]);
  });

  it("does NOT fire when a peer already claimed the tick", async () => {
    const first: string[] = [];
    const second: string[] = [];
    bridge(first).fireForTest("legacy", SLOT);
    bridge(second).fireForTest("legacy", SLOT);
    expect(first).toEqual(["cron:legacy"]);
    // Before the fix this was also ["cron:legacy"] — the duplicate this and
    // #1458 both exist to stop.
    expect(second).toEqual([]);
  });

  it("still fires the NEXT slot after losing the previous one", () => {
    // A claim is per (recipe, slot). Losing one tick must not wedge the recipe
    // permanently — that failure mode is worse than the duplicate it prevents,
    // and quieter.
    const a: string[] = [];
    const b: string[] = [];
    return (async () => {
      bridge(a).fireForTest("legacy", SLOT);
      bridge(b).fireForTest("legacy", SLOT);
      bridge(b).fireForTest("legacy", SLOT + 3_600_000);
      expect(b).toEqual(["cron:legacy"]);
    })();
  });

  it("does not burn the slot for a recipe it cannot run", async () => {
    // The ordering invariant #1461 established: every local "should I even run
    // this" decision comes FIRST. A bridge that claims and then discovers it
    // cannot run the recipe blocks a differently-configured peer that could
    // have — and the recipe then runs nowhere at all.
    const missing: string[] = [];
    bridge(missing).fireForTest("does-not-exist", SLOT);
    expect(missing).toEqual([]);

    // The slot must still be available to a peer that CAN run it.
    const peer: string[] = [];
    bridge(peer).fireForTest("legacy", SLOT);
    expect(peer).toEqual(["cron:legacy"]);
  });

  it("does not burn the slot for a recipe disabled on this bridge", async () => {
    const disabled: string[] = [];
    const s = new RecipeScheduler({
      recipesDir,
      enqueue: ({ triggerSource }) => {
        disabled.push(triggerSource);
        return "tid";
      },
      disabledRecipes: ["legacy"],
      claim: { claimsDir },
    });
    s.fireForTest("legacy", SLOT);
    expect(disabled).toEqual([]);

    const peer: string[] = [];
    bridge(peer).fireForTest("legacy", SLOT);
    expect(peer).toEqual(["cron:legacy"]);
  });

  it("fires with no slot given, since a manual call has no tick to claim", async () => {
    const enqueued: string[] = [];
    bridge(enqueued).fireForTest("legacy");
    bridge(enqueued).fireForTest("legacy");
    expect(enqueued).toEqual(["cron:legacy", "cron:legacy"]);
  });
});
