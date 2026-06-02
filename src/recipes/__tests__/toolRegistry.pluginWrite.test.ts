/**
 * Regression test — plugin tools must honour `annotations.destructiveHint`
 * so they participate in the kill-switch gate + idempotency ledger.
 *
 * Before the fix, `registerPluginTools` hard-coded `isWrite: false` for every
 * plugin tool, so a destructive plugin tool bypassed `assertWriteAllowed` and
 * the write-effect dedup ledger entirely.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRegistry,
  getTool,
  registerPluginTools,
} from "../toolRegistry.js";

function makePluginTool(name: string, destructiveHint?: boolean) {
  return {
    name,
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    schema: {
      name,
      description: `plugin tool ${name}`,
      inputSchema: { type: "object" as const },
      ...(destructiveHint === undefined
        ? {}
        : { annotations: { destructiveHint } }),
    },
  };
}

describe("registerPluginTools — destructiveHint → isWrite", () => {
  beforeEach(() => {
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
  });

  it("registers a tool with annotations.destructiveHint:true as a write tool", () => {
    const count = registerPluginTools([
      makePluginTool("myplug_deleteThing", true),
    ]);
    expect(count).toBe(1);
    const tool = getTool("myplug_deleteThing");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
  });

  it("leaves a tool without destructiveHint as a non-write tool", () => {
    registerPluginTools([makePluginTool("myplug_readThing")]);
    const tool = getTool("myplug_readThing");
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
  });

  it("treats destructiveHint:false as a non-write tool", () => {
    registerPluginTools([makePluginTool("myplug_safeThing", false)]);
    const tool = getTool("myplug_safeThing");
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
  });
});
