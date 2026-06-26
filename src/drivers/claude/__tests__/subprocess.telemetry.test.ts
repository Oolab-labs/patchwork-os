/**
 * audit P0-4 — capture the `claude -p` stream-json result event's usage/cost
 * telemetry into ProviderTaskResult.providerMeta.
 *
 * Before: the result event's `usage`, `total_cost_usd`, `num_turns`,
 * `duration_ms` were discarded (not even on the StreamJsonEvent type), so
 * providerMeta was empty and RunBudget/runlog saw zero token usage for every
 * subprocess (claude -p) step — the "tool-call telem=0" symptom.
 *
 * After: the result event populates providerMeta.{inputTokens,outputTokens,
 * costUsd,numTurns,durationMs,model}, which the existing
 * providerMetaToUsage → RunBudget.reconcile path already consumes (and which is
 * recorded to the runlog). `subprocess` is NOT a BILLABLE_DRIVER, so usdMax
 * stays fail-open — this only surfaces telemetry, it does not start charging
 * subscription runs.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
}

let mockChild: MockChild;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      mockChild = new MockChild();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      (mockChild.stdout as { setEncoding?: () => void }).setEncoding = vi.fn();
      (mockChild.stderr as { setEncoding?: () => void }).setEncoding = vi.fn();
      return mockChild;
    }),
  };
});

import { providerMetaToUsage } from "../../../recipes/yamlRunner.js";
import type { ProviderTaskResult } from "../../types.js";
import { SubprocessDriver } from "../subprocess.js";

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "hello",
    workspace: "/workspace/test",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  } as Parameters<SubprocessDriver["run"]>[0];
}

function newDriver() {
  return new SubprocessDriver("claude", "ant", vi.fn());
}

/** Run the driver, emit a single result event, close, and return the result. */
async function runWithResult(
  driver: SubprocessDriver,
  resultEvent: Record<string, unknown>,
  input = makeInput(),
): Promise<ProviderTaskResult> {
  const p = driver.run(input);
  await new Promise<void>((r) => setTimeout(r, 0));
  mockChild.stdout.emit("data", `${JSON.stringify(resultEvent)}\n`);
  mockChild.emit("close", 0);
  return p;
}

describe("SubprocessDriver result-event telemetry (P0-4)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("captures usage + cost from the result event into providerMeta", async () => {
    const result = await runWithResult(newDriver(), {
      type: "result",
      is_error: false,
      result: "done",
      usage: { input_tokens: 1200, output_tokens: 340 },
      total_cost_usd: 0.0123,
      num_turns: 3,
      duration_ms: 5400,
    });
    expect(result.providerMeta).toBeDefined();
    expect(result.providerMeta).toMatchObject({
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0123,
      numTurns: 3,
      durationMs: 5400,
    });
  });

  it("providerMeta is consumable by the existing providerMetaToUsage path", async () => {
    const result = await runWithResult(newDriver(), {
      type: "result",
      is_error: false,
      result: "done",
      usage: { input_tokens: 800, output_tokens: 200 },
    });
    expect(providerMetaToUsage(result.providerMeta)).toEqual({
      inputTokens: 800,
      outputTokens: 200,
    });
  });

  it("omits token fields when the result event has no usage (old binary) — no crash", async () => {
    const result = await runWithResult(newDriver(), {
      type: "result",
      is_error: false,
      result: "done",
    });
    // No usage → providerMetaToUsage returns undefined (RunBudget fails open as before).
    expect(providerMetaToUsage(result.providerMeta)).toBeUndefined();
    expect(result.text).toBe("done");
  });

  it("ignores malformed usage (non-number tokens) without poisoning providerMeta", async () => {
    const result = await runWithResult(newDriver(), {
      type: "result",
      is_error: false,
      result: "done",
      usage: { input_tokens: "lots", output_tokens: null },
    });
    expect(providerMetaToUsage(result.providerMeta)).toBeUndefined();
  });
});
