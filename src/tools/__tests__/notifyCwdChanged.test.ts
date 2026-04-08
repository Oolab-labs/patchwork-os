import { describe, expect, it, vi } from "vitest";
import type { AutomationHooks } from "../../automation.js";
import { createNotifyCwdChangedTool } from "../notifyCwdChanged.js";

function makeHooks(handleCwdChanged = vi.fn()): AutomationHooks {
  return { handleCwdChanged } as unknown as AutomationHooks;
}

describe("notifyCwdChanged tool", () => {
  it("calls handleCwdChanged with the provided cwd", async () => {
    const handleCwdChanged = vi.fn();
    const { handler } = createNotifyCwdChangedTool(makeHooks(handleCwdChanged));
    const result = await handler({ cwd: "/workspace/myproject" });
    expect(handleCwdChanged).toHaveBeenCalledWith("/workspace/myproject");
    expect(result.content[0]?.text).toContain("/workspace/myproject");
  });

  it("returns success content even when policy is not configured (no-op)", async () => {
    const handleCwdChanged = vi.fn(); // no-op — policy disabled or absent
    const { handler } = createNotifyCwdChangedTool(makeHooks(handleCwdChanged));
    const result = await handler({ cwd: "/tmp" });
    expect(result.isError).toBeUndefined();
    expect(typeof result.content[0]?.text).toBe("string");
  });

  it("schema has correct name and required cwd field", () => {
    const { schema } = createNotifyCwdChangedTool(makeHooks());
    expect(schema.name).toBe("notifyCwdChanged");
    expect(schema.inputSchema.required).toContain("cwd");
  });
});
