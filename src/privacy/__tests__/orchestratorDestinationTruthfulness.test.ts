/**
 * Gate 3C — the facts used to govern an orchestrator dispatch must be the
 * exact immutable facts handed to its driver. A driver name is not a
 * destination: `local` may legitimately point at an authorised off-box
 * endpoint.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import type { ProviderDriver, ProviderTaskInput } from "../../drivers/types.js";

type DestinationFacts = Readonly<{ driver: string; endpoint?: string }>;
type FactsAwareInput = ProviderTaskInput & {
  destinationFacts?: DestinationFacts;
};

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const OFF_BOX_ENDPOINT = "https://inference.example.test/v1";

let home: string;
let previousHome: string | undefined;

function ledgerRows(name: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path.join(home, name), "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.kind !== "chain-start" && row.kind !== "rotation");
  } catch {
    return [];
  }
}

function writePrivacyConfig(): void {
  const destinations = {
    "on-box": {
      type: "local",
      classifications: ["restricted"],
      drivers: ["local"],
    },
    "off-box": {
      type: "remote",
      classifications: ["restricted"],
      drivers: ["local"],
    },
  };
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      privacy: {
        destinations,
        shadow: { destinations },
        orchestrator: { classification: "restricted" },
      },
    }),
  );
}

function factsAwareDriver(
  endpoint: string,
  afterResolve?: () => void,
): {
  driver: ProviderDriver;
  facts: DestinationFacts;
  usedEndpoint: () => string | undefined;
  receivedFacts: () => DestinationFacts | undefined;
} {
  const facts = Object.freeze({ driver: "local", endpoint });
  let usedEndpoint: string | undefined;
  let receivedFacts: DestinationFacts | undefined;
  let mutableEndpoint = endpoint;

  const driver = {
    name: "local",
    resolveDestinationFacts(): DestinationFacts {
      afterResolve?.();
      // Simulate later mutable config changing after this dispatch captured
      // its facts. Execution must still use `facts`, not this new value.
      if (afterResolve) mutableEndpoint = OFF_BOX_ENDPOINT;
      return facts;
    },
    async run(input: FactsAwareInput) {
      receivedFacts = input.destinationFacts;
      usedEndpoint = input.destinationFacts?.endpoint ?? mutableEndpoint;
      return { text: "dispatched", exitCode: 0, durationMs: 1 };
    },
  } as unknown as ProviderDriver;

  return {
    driver,
    facts,
    usedEndpoint: () => usedEndpoint,
    receivedFacts: () => receivedFacts,
  };
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "pw-gate3c-"));
  previousHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = home;
  writePrivacyConfig();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

async function run(driver: ProviderDriver): Promise<void> {
  const orchestrator = new ClaudeOrchestrator(driver, home, () => {});
  const task = await orchestrator.runAndWait({ prompt: "synthetic prompt" });
  expect(task.status).toBe("done");
}

describe("orchestrator resolved destination truthfulness", () => {
  it("classifies an authorised off-box local-driver endpoint as remote everywhere", async () => {
    const observed = factsAwareDriver(OFF_BOX_ENDPOINT);
    await run(observed.driver);

    expect.soft(observed.usedEndpoint()).toBe(OFF_BOX_ENDPOINT);
    expect
      .soft(ledgerRows("boundary_receipts.jsonl"))
      .toMatchObject([{ destinationId: "off-box", destinationType: "remote" }]);
    expect.soft(ledgerRows("privacy_shadow.jsonl")).toMatchObject([
      {
        path: "orchestrator-task",
        destinationId: "off-box",
        destinationType: "remote",
        enforcing: true,
      },
    ]);
    expect.soft(observed.receivedFacts()).toBe(observed.facts);
    expect.soft(Object.isFrozen(observed.receivedFacts())).toBe(true);
  });

  it("preserves genuine local execution and local receipts", async () => {
    const observed = factsAwareDriver(LOCAL_ENDPOINT);
    await run(observed.driver);

    expect(observed.usedEndpoint()).toBe(LOCAL_ENDPOINT);
    expect(observed.receivedFacts()).toBe(observed.facts);
    expect(ledgerRows("boundary_receipts.jsonl")).toMatchObject([
      { destinationId: "on-box", destinationType: "local" },
    ]);
    expect(ledgerRows("privacy_shadow.jsonl")).toMatchObject([
      { destinationId: "on-box", destinationType: "local" },
    ]);
  });

  it("captures one immutable endpoint before policy and execution", async () => {
    const observed = factsAwareDriver(LOCAL_ENDPOINT, () => {});
    await run(observed.driver);

    expect(observed.receivedFacts()).toBe(observed.facts);
    expect(observed.usedEndpoint()).toBe(LOCAL_ENDPOINT);
    expect(ledgerRows("boundary_receipts.jsonl")[0]).toMatchObject({
      destinationId: "on-box",
      destinationType: "local",
    });
  });
});
