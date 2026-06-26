/**
 * Wiring-completeness gate for recipe trigger dispatch.
 *
 * Guards the bug class that made file_watch/git_hook recipes decorative: a
 * recipe TriggerType that the runtime never dispatches. Every TriggerType MUST
 * be classified into a known dispatch path or explicitly recorded as an unwired
 * gap. The `Record<TriggerType, DispatchPath>` below is exhaustive by
 * construction — tsc fails to compile if a new TriggerType is added without a
 * key, so a new trigger can never silently ship "parsed but never fired". The
 * runtime checks then verify the classification is accurate: every
 * "automation-hook" trigger is actually collected, and nothing else is.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectEventTriggerPrograms } from "../eventTriggerPrograms.js";
import type { TriggerType } from "../schema.js";

type DispatchPath =
  | "automation-hook" // compiled + registered into AutomationHooks (PR #1016)
  | "scheduler" // RecipeScheduler (cron)
  | "webhook" // POST /hooks/* → server.webhookFn
  | "cli" // `patchwork run <name>`
  | "chained-runner" // dispatchRecipe → chainedRunner
  | "UNWIRED"; // no runtime dispatch yet — tracked follow-up

/**
 * THE GATE. Adding a TriggerType to schema.ts without a key here is a compile
 * error. Flipping an entry to "automation-hook" without wiring the compiler
 * fails the runtime check below. Removing an entry from UNWIRED must coincide
 * with KNOWN_UNWIRED.
 */
const TRIGGER_DISPATCH: Record<TriggerType, DispatchPath> = {
  file_watch: "automation-hook",
  git_hook: "automation-hook",
  cron: "scheduler",
  webhook: "webhook",
  manual: "cli",
  chained: "chained-runner",
  // Wired: compileRecipe maps on_file_save→onFileSave and on_test_run→
  // onTestRun / onTestPassAfterFailure (by filter). The runtime check below
  // enforces that they are actually collected end-to-end.
  on_file_save: "automation-hook",
  on_test_run: "automation-hook",
};

// Every TriggerType now has a live dispatch path. If a new trigger lands
// unwired, classify it "UNWIRED" here AND add it to this set in the same
// change — the drift check below then keeps the gap explicit.
const KNOWN_UNWIRED: ReadonlySet<TriggerType> = new Set<TriggerType>([]);

const NAME: Record<TriggerType, string> = {
  webhook: "g-webhook",
  cron: "g-cron",
  file_watch: "g-file-watch",
  git_hook: "g-git-hook",
  manual: "g-manual",
  chained: "g-chained",
  on_file_save: "g-on-file-save",
  on_test_run: "g-on-test-run",
};

const TRIGGER_BLOCK: Record<TriggerType, string> = {
  webhook: 'trigger:\n  type: webhook\n  path: "/g-webhook"',
  cron: 'trigger:\n  type: cron\n  schedule: "0 9 * * *"',
  file_watch: 'trigger:\n  type: file_watch\n  patterns:\n    - "**/*.ts"',
  git_hook: "trigger:\n  type: git_hook\n  event: post-commit",
  manual: "trigger:\n  type: manual",
  chained: "trigger:\n  type: chained",
  on_file_save: "trigger:\n  type: on_file_save",
  on_test_run: "trigger:\n  type: on_test_run",
};

function recipeYaml(name: string, block: string): string {
  return `name: ${name}\nversion: "1.0.0"\n${block}\nsteps:\n  - id: s1\n    tool: getGitStatus\n    params: {}\n`;
}

const ALL_TRIGGERS = Object.keys(NAME) as TriggerType[];

describe("recipe trigger dispatch completeness", () => {
  let dir: string;
  let collectedNames: Set<string>;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pw-trigger-gate-"));
    for (const t of ALL_TRIGGERS) {
      writeFileSync(
        path.join(dir, `${NAME[t]}.yaml`),
        recipeYaml(NAME[t], TRIGGER_BLOCK[t]),
        "utf-8",
      );
    }
    collectedNames = new Set(
      collectEventTriggerPrograms(dir, { disabledRecipes: [] }).recipeNames,
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies every TriggerType (exhaustive Record = compile-time gate)", () => {
    // If this fails, a TriggerType lost its NAME/TRIGGER_BLOCK fixture — but the
    // Record<TriggerType, …> maps would have failed tsc first.
    for (const t of ALL_TRIGGERS) {
      expect(TRIGGER_DISPATCH[t]).toBeDefined();
    }
  });

  it("UNWIRED set has not drifted (wiring one forces a deliberate update)", () => {
    const unwired = ALL_TRIGGERS.filter(
      (t) => TRIGGER_DISPATCH[t] === "UNWIRED",
    ).sort();
    expect(unwired).toEqual([...KNOWN_UNWIRED].sort());
  });

  it("every 'automation-hook' trigger is actually collected; nothing else is", () => {
    for (const t of ALL_TRIGGERS) {
      const shouldCollect = TRIGGER_DISPATCH[t] === "automation-hook";
      expect(
        collectedNames.has(NAME[t]),
        `${t} (${TRIGGER_DISPATCH[t]}) collected=${collectedNames.has(NAME[t])}, expected=${shouldCollect}`,
      ).toBe(shouldCollect);
    }
  });

  it("the automation-hook set matches the compiler's event triggers", () => {
    const hookTriggers = ALL_TRIGGERS.filter(
      (t) => TRIGGER_DISPATCH[t] === "automation-hook",
    ).sort();
    expect(hookTriggers).toEqual([
      "file_watch",
      "git_hook",
      "on_file_save",
      "on_test_run",
    ]);
  });
});
