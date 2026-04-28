/**
 * Verifies the global write-tier kill switch wiring at the executeTool
 * dispatch boundary. The kill switch (`PATCHWORK_FLAG_KILL_SWITCH_WRITES`,
 * registered as `kill-switch.writes` in `src/featureFlags.ts`) had its
 * helpers in place but no call sites enforcing it; this exercises the
 * wiring so a regression that drops the check is caught immediately.
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
import { clearRegistry, executeTool, registerTool } from "../toolRegistry.js";
import type { RunContext, StepDeps } from "../yamlRunner.js";

const KILL_SWITCH_ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";

const dummyContext = {
  params: {},
  step: {},
  ctx: { env: {}, steps: {} } as unknown as RunContext,
  deps: {} as StepDeps,
};

describe("executeTool — kill switch enforcement", () => {
  let writeExec: MockInstance;
  let readExec: MockInstance;

  beforeEach(() => {
    clearRegistry();
    delete process.env[KILL_SWITCH_ENV];
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
      execute: writeExec as unknown as RegisteredToolExecute,
    });
    registerTool({
      id: "test.read",
      namespace: "test",
      description: "test read tool",
      paramsSchema: { type: "object" },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: readExec as unknown as RegisteredToolExecute,
    });
  });

  afterEach(() => {
    delete process.env[KILL_SWITCH_ENV];
    clearRegistry();
  });

  it("executes write tools normally when kill switch is off", async () => {
    const result = await executeTool("test.write", dummyContext);
    expect(result).toBe("wrote");
    expect(writeExec).toHaveBeenCalledTimes(1);
  });

  it("blocks write tools when kill switch is active", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    await expect(executeTool("test.write", dummyContext)).rejects.toThrow(
      /Write operation blocked by kill switch: test\.write/,
    );
    expect(writeExec).not.toHaveBeenCalled();
  });

  it("still executes read tools when kill switch is active", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    const result = await executeTool("test.read", dummyContext);
    expect(result).toBe("read");
    expect(readExec).toHaveBeenCalledTimes(1);
  });

  it("error message includes the recovery instruction", async () => {
    process.env[KILL_SWITCH_ENV] = "true";
    await expect(executeTool("test.write", dummyContext)).rejects.toThrow(
      /Unset PATCHWORK_FLAG_KILL_SWITCH_WRITES/,
    );
  });

  it("Unknown tool error fires before kill-switch check", async () => {
    process.env[KILL_SWITCH_ENV] = "1";
    // Even with kill switch on, an unknown tool should report "Unknown tool"
    // — tells the caller the right thing rather than a misleading kill-switch
    // message about a tool that doesn't exist.
    await expect(executeTool("test.nope", dummyContext)).rejects.toThrow(
      /Unknown tool: "test\.nope"/,
    );
  });
});

// Local type alias so the cast above doesn't drift if the registry's signature
// gets a new optional field — keeps the test failure surface narrow.
type RegisteredToolExecute = Parameters<typeof registerTool>[0]["execute"];
