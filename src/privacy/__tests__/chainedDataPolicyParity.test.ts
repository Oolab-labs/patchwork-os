import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerDeps } from "../../recipes/yamlRunner.js";

let patchworkHome: string;
let priorPatchworkHome: string | undefined;

beforeEach(() => {
  patchworkHome = mkdtempSync(path.join(os.tmpdir(), "pw-chain-policy-"));
  priorPatchworkHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = patchworkHome;
  writePrivacyConfig({
    destinations: {
      "synthetic-remote": {
        type: "remote",
        classifications: ["public", "internal"],
        drivers: ["anthropic"],
      },
    },
  });
  vi.resetModules();
});

afterEach(() => {
  if (priorPatchworkHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = priorPatchworkHome;
  rmSync(patchworkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function receiptRows(): Array<Record<string, unknown>> {
  return ledgerRows("boundary_receipts.jsonl");
}

function shadowRows(): Array<Record<string, unknown>> {
  return ledgerRows("privacy_shadow.jsonl");
}

function ledgerRows(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path.join(patchworkHome, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.kind !== "chain-start" && row.kind !== "rotation");
  } catch {
    return [];
  }
}

function writePrivacyConfig(privacy: Record<string, unknown>): void {
  writeFileSync(
    path.join(patchworkHome, "config.json"),
    JSON.stringify({ privacy }),
  );
}

function agentStep(id: string, dataPolicy: unknown = undefined) {
  return {
    id,
    agent: {
      prompt: `synthetic payload ${id}`,
      driver: "anthropic",
      ...(dataPolicy !== undefined ? { data_policy: dataPolicy } : {}),
    },
  };
}

function writeRecipe(
  name: string,
  trigger: "manual" | "chained",
  steps: unknown[] = [
    agentStep("send", {
      classification: "restricted",
      categories: ["synthetic-category"],
    }),
  ],
  recipeOptions: Record<string, unknown> = {},
): string {
  const filePath = path.join(patchworkHome, `${name}.yaml`);
  writeFileSync(
    filePath,
    JSON.stringify({
      name,
      trigger: { type: trigger },
      ...recipeOptions,
      steps,
    }),
  );
  return filePath;
}

function modelTransport(output: string) {
  return vi.fn(async (_prompt: string, _model: string) => output);
}

function runnerDeps(
  transport: NonNullable<RunnerDeps["claudeFn"]>,
  nowIso: string,
): RunnerDeps {
  return {
    testMode: true,
    now: () => new Date(nowIso),
    logDir: patchworkHome,
    claudeFn: transport,
    readFile: () => {
      throw new Error("synthetic file read disabled");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

async function runPair(dataPolicy: unknown = undefined) {
  const { buildChainedDeps, dispatchRecipe, loadYamlRecipe } = await import(
    "../../recipes/yamlRunner.js"
  );

  const flatTransport = modelTransport("flat transport output");
  const flatDeps = runnerDeps(flatTransport, "2026-09-16T10:00:00Z");
  const flatReceiptBefore = receiptRows().length;
  const flatShadowBefore = shadowRows().length;
  await dispatchRecipe(
    loadYamlRecipe(
      writeRecipe("flat-policy", "manual", [agentStep("send", dataPolicy)]),
    ),
    flatDeps,
  );

  const chainedTransport = modelTransport("chained transport output");
  const chainedDeps = runnerDeps(chainedTransport, "2026-09-16T10:01:00Z");
  const chainedReceiptBefore = receiptRows().length;
  const chainedShadowBefore = shadowRows().length;
  const chainedRecipe = loadYamlRecipe(
    writeRecipe("chained-policy", "chained", [agentStep("send", dataPolicy)]),
  );
  await dispatchRecipe(chainedRecipe, {
    ...chainedDeps,
    chainedDeps: buildChainedDeps(chainedDeps, undefined, chainedRecipe.name),
  });

  return {
    flatTransport,
    chainedTransport,
    flatReceipts: receiptRows().slice(flatReceiptBefore, chainedReceiptBefore),
    chainedReceipts: receiptRows().slice(chainedReceiptBefore),
    flatShadow: shadowRows().slice(flatShadowBefore, chainedShadowBefore),
    chainedShadow: shadowRows().slice(chainedShadowBefore),
  };
}

describe("chained data_policy production-path parity", () => {
  it("refuses the same declared restricted policy in flat and chained recipes", async () => {
    const result = await runPair({
      classification: "restricted",
      categories: ["synthetic-category"],
    });

    expect(result.flatTransport).not.toHaveBeenCalled();
    expect(result.flatReceipts).toHaveLength(1);
    expect(result.flatReceipts[0]).toMatchObject({
      decision: "DENY",
      classification: "restricted",
      categories: ["synthetic-category"],
      labelSource: "declared",
      destinationId: "synthetic-remote",
    });

    expect(result.chainedReceipts).toHaveLength(1);
    expect(result.chainedReceipts[0]).toMatchObject({
      decision: "DENY",
      classification: "restricted",
      categories: ["synthetic-category"],
      labelSource: "declared",
      destinationId: "synthetic-remote",
    });
    expect(result.chainedTransport).not.toHaveBeenCalled();
  });

  it("dispatches accepted declarations with matching metadata", async () => {
    writePrivacyConfig({
      destinations: {
        "synthetic-remote": {
          type: "remote",
          classifications: ["restricted"],
          drivers: ["anthropic"],
        },
      },
    });
    const result = await runPair({
      classification: "restricted",
      categories: ["synthetic-category"],
    });

    expect(result.flatTransport).toHaveBeenCalledTimes(1);
    expect(result.chainedTransport).toHaveBeenCalledTimes(1);
    for (const rows of [result.flatReceipts, result.chainedReceipts]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "ALLOW",
        classification: "restricted",
        categories: ["synthetic-category"],
        labelSource: "declared",
      });
    }
  });

  it("preserves the absent declaration default and assumed label", async () => {
    const result = await runPair();

    expect(result.flatTransport).toHaveBeenCalledTimes(1);
    expect(result.chainedTransport).toHaveBeenCalledTimes(1);
    for (const rows of [result.flatReceipts, result.chainedReceipts]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "ALLOW",
        classification: "internal",
        labelSource: "assumed",
      });
    }
  });

  it("preserves fail-closed parsing for an invalid declared classification", async () => {
    const result = await runPair({ classification: "synthetic-typo" });

    expect(result.flatTransport).not.toHaveBeenCalled();
    expect(result.chainedTransport).not.toHaveBeenCalled();
    for (const rows of [result.flatReceipts, result.chainedReceipts]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "DENY",
        classification: "internal",
        labelSource: "declared",
      });
      expect(rows[0]?.reason).toMatch(/unrecognised classification/);
    }
  });

  it("observes a declared shadow denial without blocking either runner", async () => {
    writePrivacyConfig({
      shadow: {
        destinations: {
          "shadow-remote": {
            type: "remote",
            classifications: ["internal"],
            drivers: ["anthropic"],
          },
        },
      },
    });
    const result = await runPair({
      classification: "restricted",
      categories: ["shadow-category"],
    });

    expect(result.flatTransport).toHaveBeenCalledTimes(1);
    expect(result.chainedTransport).toHaveBeenCalledTimes(1);
    expect(result.flatReceipts).toHaveLength(0);
    expect(result.chainedReceipts).toHaveLength(0);
    for (const rows of [result.flatShadow, result.chainedShadow]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "DENY",
        classification: "restricted",
        categories: ["shadow-category"],
        labelSource: "declared",
        enforcing: false,
      });
    }
  });

  it("keeps enforcing and shadow decisions distinct", async () => {
    writePrivacyConfig({
      destinations: {
        "live-remote": {
          type: "remote",
          classifications: ["restricted"],
          drivers: ["anthropic"],
        },
      },
      shadow: {
        destinations: {
          "shadow-remote": {
            type: "remote",
            classifications: ["internal"],
            drivers: ["anthropic"],
          },
        },
      },
    });
    const result = await runPair({ classification: "restricted" });

    expect(result.flatTransport).toHaveBeenCalledTimes(1);
    expect(result.chainedTransport).toHaveBeenCalledTimes(1);
    for (const rows of [result.flatReceipts, result.chainedReceipts]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "ALLOW",
        classification: "restricted",
        labelSource: "declared",
      });
    }
    for (const rows of [result.flatShadow, result.chainedShadow]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "DENY",
        classification: "restricted",
        labelSource: "declared",
        enforcing: true,
      });
    }
  });

  it("keeps dispatch inert when neither live nor shadow destinations resolve", async () => {
    writePrivacyConfig({});
    const result = await runPair({ classification: "restricted" });

    expect(result.flatTransport).toHaveBeenCalledTimes(1);
    expect(result.chainedTransport).toHaveBeenCalledTimes(1);
    expect(result.flatReceipts).toHaveLength(0);
    expect(result.chainedReceipts).toHaveLength(0);
    expect(result.flatShadow).toHaveLength(0);
    expect(result.chainedShadow).toHaveLength(0);
  });

  it("does not leak declarations between concurrent chained agent calls", async () => {
    const { buildChainedDeps, dispatchRecipe, loadYamlRecipe } = await import(
      "../../recipes/yamlRunner.js"
    );
    const arrivals = new Set<string>();
    const completions = new Set<string>();
    const waiters: Array<() => void> = [];
    let released = false;
    let observeBothArrivals: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => {
      observeBothArrivals = resolve;
    });
    const transport = vi.fn(async (prompt: string, _model: string) => {
      const callId = prompt.includes("synthetic payload internal")
        ? "internal"
        : prompt.includes("synthetic payload public")
          ? "public"
          : "unexpected";
      arrivals.add(callId);
      if (arrivals.size === 2) observeBothArrivals?.();
      if (!released) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      completions.add(callId);
      return `${callId} transport output`;
    });
    const deps = runnerDeps(transport, "2026-09-16T10:02:00Z");
    const before = receiptRows().length;
    const recipe = loadYamlRecipe(
      writeRecipe(
        "concurrent-policy",
        "chained",
        [
          agentStep("internal", {
            classification: "internal",
            categories: ["internal-category"],
          }),
          agentStep("public", {
            classification: "public",
            categories: ["public-category"],
          }),
        ],
        {
          maxConcurrency: 2,
        },
      ),
    );
    const run = dispatchRecipe(recipe, {
      ...deps,
      chainedDeps: buildChainedDeps(deps, undefined, recipe.name),
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothArrived,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () =>
              reject(
                new Error(
                  "concurrency barrier: both distinct transport calls did not arrive before release",
                ),
              ),
            1_000,
          );
        }),
      ]);
      expect(arrivals).toEqual(new Set(["internal", "public"]));
      expect(completions).toEqual(new Set());
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      released = true;
      for (const release of waiters.splice(0)) release();
      await run;
    }
    const rows = receiptRows().slice(before);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(arrivals).toEqual(new Set(["internal", "public"]));
    expect(completions).toEqual(new Set(["internal", "public"]));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "ALLOW",
          classification: "internal",
          categories: ["internal-category"],
          labelSource: "declared",
        }),
        expect.objectContaining({
          decision: "ALLOW",
          classification: "public",
          categories: ["public-category"],
          labelSource: "declared",
        }),
      ]),
    );
    expect(
      new Set(
        rows.map((row) =>
          JSON.stringify([
            row.decision,
            row.classification,
            row.categories,
            row.labelSource,
          ]),
        ),
      ).size,
    ).toBe(2);
  });

  it("applies a nested chained child's own declaration", async () => {
    const { buildChainedDeps, dispatchRecipe, loadYamlRecipe } = await import(
      "../../recipes/yamlRunner.js"
    );
    const childPath = writeRecipe("nested-child", "chained", [
      agentStep("child-send", {
        classification: "restricted",
        categories: ["child-category"],
      }),
    ]);
    const parentPath = writeRecipe("nested-parent", "chained", [
      { id: "call-child", recipe: `./${path.basename(childPath)}` },
    ]);
    const transport = modelTransport("transport output");
    const deps = runnerDeps(transport, "2026-09-16T10:03:00Z");
    const before = receiptRows().length;
    const recipe = loadYamlRecipe(parentPath);

    await dispatchRecipe(recipe, {
      ...deps,
      chainedDeps: buildChainedDeps(deps, undefined, recipe.name),
      chainedOptions: { sourcePath: parentPath },
    });
    const rows = receiptRows().slice(before);

    expect(transport).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: "DENY",
      classification: "restricted",
      categories: ["child-category"],
      labelSource: "declared",
    });
  });
});
