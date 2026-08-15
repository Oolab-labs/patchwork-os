/**
 * End-to-end proof that a DECLARED classification reaches the boundary.
 *
 * The audit that produced this test reproduced the opposite: no production
 * call site populated `AgentExecutorInput.boundary`, so `parseDataPolicy`
 * always received `undefined` and every step — however labelled — was judged
 * at the default `internal`. A step declaring `restricted` was dispatched to a
 * remote model AND a receipt was written asserting `classification: internal`.
 *
 * A false-affirmative audit record is worse than a missing one: ADR-0021
 * frames receipts as the "we did not send this" assertion, and that record
 * asserted a check that never happened on the declared label.
 *
 * These drive the REAL runner (`runYamlRecipe`), not `executeAgent` directly.
 * Every previous boundary test hand-injected `boundary: {dataPolicy}` into the
 * engine, which is exactly why the missing wiring survived three PRs and a
 * green suite.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../../recipes/yamlRunner.js";

let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-boundary-e2e-"));
  priorHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = home;
  // The registry ADR-0021 documents: a remote destination cleared only for
  // public/internal. Synthetic, as every fixture here must be.
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      privacy: {
        destinations: {
          "cloud-primary": {
            type: "remote",
            classifications: ["public", "internal"],
            drivers: ["anthropic"],
          },
        },
      },
    }),
  );
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

function runWith(dataPolicy: unknown, claudeFn: ReturnType<typeof vi.fn>) {
  const recipe = {
    name: "boundary-e2e",
    trigger: { type: "manual" },
    steps: [
      {
        id: "s1",
        agent: {
          prompt: "SYNTHETIC-SENSITIVE-PAYLOAD",
          driver: "anthropic",
          ...(dataPolicy !== undefined ? { data_policy: dataPolicy } : {}),
        },
      },
    ],
  } as unknown as YamlRecipe;

  const deps: RunnerDeps = {
    now: () => new Date("2026-08-15T08:00:00Z"),
    logDir: home,
    claudeFn,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  } as unknown as RunnerDeps;

  return runYamlRecipe(recipe, deps, { testMode: true } as never);
}

function receipts(): Array<Record<string, unknown>> {
  try {
    return readFileSync(path.join(home, "boundary_receipts.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("a declared classification reaches the boundary (end to end)", () => {
  it("REFUSES a `restricted` step against a destination cleared only for internal", async () => {
    const claudeFn = vi.fn(async () => "model output");
    await runWith({ classification: "restricted" }, claudeFn);

    // The invariant. Asserting the DRIVER was never called — not the message —
    // because a message assertion passes even if the prompt was already sent.
    expect(claudeFn).not.toHaveBeenCalled();
  });

  it("records the DECLARED classification in the receipt, not the default", async () => {
    const claudeFn = vi.fn(async () => "model output");
    await runWith({ classification: "restricted" }, claudeFn);

    const rs = receipts();
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]).toMatchObject({
      classification: "restricted",
      destinationId: "cloud-primary",
    });
    // The false-affirmative that shipped: a DENY-worthy step recorded as
    // `internal` and allowed.
    expect(rs[0]?.classification).not.toBe("internal");
  });

  it("still ALLOWS a step whose declared class the destination is cleared for", async () => {
    const claudeFn = vi.fn(async () => "model output");
    await runWith({ classification: "internal" }, claudeFn);
    expect(claudeFn).toHaveBeenCalled();
  });

  it("REFUSES a typo'd classification rather than defaulting it", async () => {
    // `parseDataPolicy`'s fail-closed branch was dead in production: it can
    // only reject a malformed value it is actually given.
    const claudeFn = vi.fn(async () => "model output");
    await runWith({ classification: "confidentail" }, claudeFn);
    expect(claudeFn).not.toHaveBeenCalled();
  });

  it("never writes the payload into the receipt", async () => {
    const claudeFn = vi.fn(async () => "model output");
    await runWith({ classification: "restricted" }, claudeFn);
    const raw = readFileSync(
      path.join(home, "boundary_receipts.jsonl"),
      "utf-8",
    );
    expect(raw).not.toContain("SYNTHETIC-SENSITIVE-PAYLOAD");
  });
});
