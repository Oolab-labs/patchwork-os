/**
 * `patchwork recipe run --local` must apply the owning worker's gate, as a
 * bridge run does.
 *
 * `resolveLocalGovernance` built only the tier gate (a terminal prompt). It
 * never asked whether a worker owns the recipe, so under the governed profile
 * a worker-owned recipe run locally skipped the worker's governance entirely:
 * its `forbids` rules did not apply (a "yes" at the prompt let a forbidden
 * write through) and no gate decision was recorded.
 *
 * Human decisions for a local run go to the terminal — the bridge's approval
 * queue has no dashboard attached in a CLI process, so queueing would leave a
 * gated step waiting for an answer that cannot come.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDeps, makeSandbox } from "../../__tests__/phase0/_harness.js";
import { resolveLocalGovernance } from "../../commands/recipe.js";
import { runYamlRecipe, type YamlRecipe } from "../../recipes/yamlRunner.js";
import { _resetActiveProfileForTesting } from "../profile.js";
import "../../recipes/tools/file.js";

const RECIPE = "local-worker-recipe";

let sandbox: ReturnType<typeof makeSandbox>;

function writeWorker(extra = "") {
  const dir = path.join(sandbox.dir, "workers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "example.worker.yaml"),
    `id: example-worker\nname: Example Worker\nrecipe: ${RECIPE}\nowns:\n  - fs-write\nautonomyCeiling: 4\n${extra}`,
  );
}

beforeEach(() => {
  sandbox = makeSandbox("local-worker-gate");
  _resetActiveProfileForTesting();
  writeFileSync(
    path.join(sandbox.dir, "config.json"),
    JSON.stringify({ profile: "governed" }),
  );
});
afterEach(() => {
  _resetActiveProfileForTesting();
  sandbox.dispose();
});

async function runLocal(io: { isTTY: boolean; answer?: string }) {
  const ask = vi.fn(async () => io.answer ?? "n");
  const gov = await resolveLocalGovernance(
    undefined,
    { isTTY: io.isTTY, ask },
    RECIPE,
  );
  const writeFile = vi.fn();
  const recipe = {
    name: RECIPE,
    trigger: { type: "manual" },
    steps: [{ tool: "file.write", path: "out.txt", content: "x", into: "w" }],
  } as unknown as YamlRecipe;
  const result = await runYamlRecipe(recipe, {
    ...baseDeps(sandbox, { writeFile }),
    ...gov,
  });
  return { ask, writeFile, result, gov };
}

function gateRows(): Array<Record<string, unknown>> {
  const p = path.join(sandbox.dir, "worker_gate_decisions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === undefined);
}

describe("recipe run --local applies the owning worker's gate", () => {
  it("a forbidden action is refused even when the operator answers yes", async () => {
    writeWorker(
      "forbids:\n  - match: fs-write\n    reason: example ban on file writes\n",
    );
    const { ask, writeFile, result } = await runLocal({
      isTTY: true,
      answer: "y",
    });
    expect(
      writeFile,
      "the forbidden write did not happen",
    ).not.toHaveBeenCalled();
    expect(
      ask,
      "nobody is asked to unlock a forbidden action",
    ).not.toHaveBeenCalled();
    expect(result.errorMessage ?? "").not.toBe("");
  });

  it("the worker gate is marked as injected, so the recipe cannot opt out", async () => {
    writeWorker();
    const { gov } = await runLocal({ isTTY: false });
    expect(gov.gateAutomatedRuns).toBe(true);
  });

  it("a gated action asks on the terminal, and a yes lets it run", async () => {
    writeWorker();
    const { ask, writeFile } = await runLocal({ isTTY: true, answer: "y" });
    expect(ask).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("a gated action with no terminal is refused, not queued", async () => {
    writeWorker();
    const { writeFile, result } = await runLocal({ isTTY: false });
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.errorMessage ?? "").not.toBe("");
  });

  it("the gate decision is recorded, as on a bridge run", async () => {
    writeWorker();
    await runLocal({ isTTY: false });
    expect(gateRows().length).toBeGreaterThan(0);
  });

  it("control: a recipe no worker owns keeps the tier gate only", async () => {
    const { gov } = await runLocal({ isTTY: false });
    expect(gov.gateAutomatedRuns).toBeUndefined();
  });
});
