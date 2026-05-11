/**
 * Integration test for PR5a — idempotency dedup at the `executeTool`
 * dispatch boundary.
 *
 * Verifies that a write tool invoked twice in the same run with the same
 * params executes exactly once and returns the cached output on the
 * second call. Read tools and tools without a ledger are unaffected.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { WriteEffectLedger } from "../idempotencyKey.js";
import {
  clearRegistry,
  executeTool,
  type RegisteredTool,
  registerTool,
} from "../toolRegistry.js";
import type { RunContext, StepDeps } from "../yamlRunner.js";

type Exec = RegisteredTool["execute"];

function makeDeps(ledger?: WriteEffectLedger): StepDeps {
  return { writeEffectLedger: ledger } as unknown as StepDeps;
}

describe("executeTool — idempotency dedup (PR5a)", () => {
  let writeExec: MockInstance;
  let readExec: MockInstance;

  beforeEach(() => {
    clearRegistry();
    writeExec = vi.fn().mockResolvedValue("wrote");
    readExec = vi.fn().mockResolvedValue("read");
    registerTool({
      id: "test.write",
      namespace: "test",
      description: "test write tool",
      paramsSchema: { type: "object" },
      outputSchema: { type: "string" },
      riskDefault: "high",
      isWrite: true,
      execute: writeExec as unknown as Exec,
    });
    registerTool({
      id: "test.read",
      namespace: "test",
      description: "test read tool",
      paramsSchema: { type: "object" },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: readExec as unknown as Exec,
    });
  });

  afterEach(() => {
    clearRegistry();
  });

  it("dedupes a duplicate write-tool call with identical params in the same run", async () => {
    const ledger = new WriteEffectLedger();
    const ctx: RunContext = { env: {}, steps: {} } as unknown as RunContext;
    const params = { channel: "#general", text: "hello" };

    const first = await executeTool("test.write", {
      params,
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });
    const second = await executeTool("test.write", {
      params,
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });

    expect(first).toBe("wrote");
    expect(second).toBe("wrote");
    expect(writeExec).toHaveBeenCalledTimes(1); // dedup'd the second
    expect(ledger.size()).toBe(1);
  });

  it("does NOT dedup when params differ (different idempotency key)", async () => {
    const ledger = new WriteEffectLedger();
    const ctx: RunContext = { env: {}, steps: {} } as unknown as RunContext;

    await executeTool("test.write", {
      params: { text: "first" },
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });
    await executeTool("test.write", {
      params: { text: "second" },
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });

    expect(writeExec).toHaveBeenCalledTimes(2);
    expect(ledger.size()).toBe(2);
  });

  it("ignores ledger entirely for read tools", async () => {
    const ledger = new WriteEffectLedger();
    const ctx: RunContext = { env: {}, steps: {} } as unknown as RunContext;
    const params = { path: "x.txt" };

    await executeTool("test.read", {
      params,
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });
    await executeTool("test.read", {
      params,
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });

    expect(readExec).toHaveBeenCalledTimes(2);
    expect(ledger.size()).toBe(0); // read tools never write to the ledger
  });

  it("falls through to a normal execute when no ledger is provided", async () => {
    const ctx: RunContext = { env: {}, steps: {} } as unknown as RunContext;
    await executeTool("test.write", {
      params: { x: 1 },
      step: {},
      ctx,
      deps: makeDeps(undefined),
    });
    await executeTool("test.write", {
      params: { x: 1 },
      step: {},
      ctx,
      deps: makeDeps(undefined),
    });
    // Without a ledger, dedup can't happen — both calls run.
    expect(writeExec).toHaveBeenCalledTimes(2);
  });

  it("does NOT record errors — retry after failure re-executes", async () => {
    clearRegistry();
    let attempts = 0;
    const failingExec = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return "succeeded";
    });
    registerTool({
      id: "test.flaky",
      namespace: "test",
      description: "flaky write tool",
      paramsSchema: { type: "object" },
      outputSchema: { type: "string" },
      riskDefault: "high",
      isWrite: true,
      execute: failingExec as unknown as Exec,
    });

    const ledger = new WriteEffectLedger();
    const ctx: RunContext = { env: {}, steps: {} } as unknown as RunContext;
    const params = { x: 1 };

    await expect(
      executeTool("test.flaky", {
        params,
        step: {},
        ctx,
        deps: makeDeps(ledger),
      }),
    ).rejects.toThrow(/transient/);
    expect(ledger.size()).toBe(0); // failure NOT recorded

    const second = await executeTool("test.flaky", {
      params,
      step: {},
      ctx,
      deps: makeDeps(ledger),
    });
    expect(second).toBe("succeeded");
    expect(failingExec).toHaveBeenCalledTimes(2);
    expect(ledger.size()).toBe(1); // now recorded
  });
});
