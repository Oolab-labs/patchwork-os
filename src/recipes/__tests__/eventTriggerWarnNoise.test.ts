/**
 * The collector warned about recipes it was never going to register, and that
 * noise is what hid the recipes it should have.
 *
 * `compileFromFile` calls `parseRecipe` FIRST and only afterwards checks
 * whether the trigger is one it compiles. So any recipe that fails a strict
 * parse produced a startup WARN — including cron, manual and webhook recipes,
 * which this collector ignores by design and whose parse failure is therefore
 * not its business.
 *
 * Measured on a live bridge: 24 recipes skipped with a WARN at every startup,
 * of which 5 actually declared an event trigger. **18 were noise** and 1 had
 * genuinely unparsable YAML. Roughly three quarters of the warnings were about
 * recipes that would never have registered anyway.
 *
 * That is not a cosmetic complaint. Five shipped templates sat dead for an
 * unknown length of time behind exactly this wall of warnings, and every one
 * was found by accident rather than by anyone reading the log. A signal buried
 * in noise of its own making is the failure this closes.
 *
 * A recipe whose YAML will not parse at all still warns: at that point nothing
 * can tell whether it wanted to be an event trigger, and guessing silence
 * would be the same mistake pointed the other way.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectEventTriggerPrograms } from "../eventTriggerPrograms.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "evt-noise-"));
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: string) {
  writeFileSync(path.join(dir, name), body);
}

function collect() {
  const warns: string[] = [];
  const res = collectEventTriggerPrograms(dir, {
    logger: { info() {}, warn: (m: string) => warns.push(m) },
  });
  return { warns, names: res.recipeNames };
}

/** Missing `id` — fails `parseRecipe`, whatever the trigger. */
const brokenStep = "steps:\n  - tool: file.read\n    path: /dev/null\n";

describe("startup warnings name only recipes this collector would register", () => {
  it("stays silent about a cron recipe that fails to parse", () => {
    write(
      "nightly.yaml",
      `name: nightly\ntrigger:\n  type: cron\n  at: "0 9 * * *"\n${brokenStep}`,
    );
    expect(collect().warns).toEqual([]);
  });

  it("stays silent about manual and webhook recipes that fail to parse", () => {
    write("a.yaml", `name: a\ntrigger:\n  type: manual\n${brokenStep}`);
    write("b.yaml", `name: b\ntrigger:\n  type: webhook\n${brokenStep}`);
    expect(collect().warns).toEqual([]);
  });

  it("STILL warns about an event-triggered recipe that fails to parse", () => {
    // The signal. This is the case that was drowned.
    write(
      "watcher.yaml",
      `name: watcher\ntrigger:\n  type: on_test_run\n${brokenStep}`,
    );
    const { warns } = collect();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/watcher\.yaml/);
  });

  it("warns for every event trigger type", () => {
    write(
      "w1.yaml",
      `name: w1\ntrigger:\n  type: git_hook\n  event: post-commit\n${brokenStep}`,
    );
    write(
      "w2.yaml",
      `name: w2\ntrigger:\n  type: on_file_save\n  patterns: ["**/*.ts"]\n${brokenStep}`,
    );
    write(
      "w3.yaml",
      `name: w3\ntrigger:\n  type: file_watch\n  patterns: ["**/*.ts"]\n${brokenStep}`,
    );
    expect(collect().warns).toHaveLength(3);
  });

  it("still warns when the YAML itself will not parse", () => {
    // Nothing can tell what it wanted to be, so silence would be the same
    // mistake pointed the other way.
    write("broken.yaml", "name: broken\ntrigger:\n  type: {oops\n");
    const { warns } = collect();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/broken\.yaml/);
  });

  it("still warns when the trigger block is absent or malformed", () => {
    write("noTrigger.yaml", `name: no-trigger\n${brokenStep}`);
    expect(collect().warns).toHaveLength(1);
  });

  it("does not change what actually registers", () => {
    write(
      "good.yaml",
      `name: good\ntrigger:\n  type: on_test_run\nsteps:\n  - id: s1\n    tool: file.read\n    path: /dev/null\n`,
    );
    write(
      "noisy.yaml",
      `name: noisy\ntrigger:\n  type: cron\n  at: "0 9 * * *"\n${brokenStep}`,
    );
    const { names, warns } = collect();
    expect(names).toEqual(["good"]);
    expect(warns).toEqual([]);
  });
});
