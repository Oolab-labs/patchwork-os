import { describe, expect, it, vi } from "vitest";
import {
  createNotifyInstructionsLoadedTool,
  createNotifyPermissionDeniedTool,
  createNotifyPostCompactTool,
  createNotifyTaskCreatedTool,
} from "../notifyHooks.js";

function makeHooks() {
  return {
    handlePostCompact: vi.fn(),
    handleInstructionsLoaded: vi.fn(),
    handleTaskCreated: vi.fn(),
    handlePermissionDenied: vi.fn(),
  };
}

describe("notifyPostCompact", () => {
  it("calls handlePostCompact and returns received:true", async () => {
    const hooks = makeHooks();
    const { handler } = createNotifyPostCompactTool(
      hooks as unknown as import("../../automation.js").AutomationHooks,
    );
    const result = await handler({});
    expect(hooks.handlePostCompact).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('"received":true') }],
    });
  });
});

describe("notifyInstructionsLoaded", () => {
  it("calls handleInstructionsLoaded and returns received:true", async () => {
    const hooks = makeHooks();
    const { handler } = createNotifyInstructionsLoadedTool(
      hooks as unknown as import("../../automation.js").AutomationHooks,
    );
    const result = await handler({});
    expect(hooks.handleInstructionsLoaded).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('"received":true') }],
    });
  });
});

describe("notifyTaskCreated", () => {
  it("calls handleTaskCreated with taskId and prompt", async () => {
    const hooks = makeHooks();
    const { handler } = createNotifyTaskCreatedTool(
      hooks as unknown as import("../../automation.js").AutomationHooks,
    );
    const result = await handler({ taskId: "t-123", prompt: "do the thing" });
    expect(hooks.handleTaskCreated).toHaveBeenCalledWith({
      taskId: "t-123",
      prompt: "do the thing",
    });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('"taskId":"t-123"') }],
    });
  });
});

describe("notifyPermissionDenied", () => {
  it("calls handlePermissionDenied with tool and reason", async () => {
    const hooks = makeHooks();
    const { handler } = createNotifyPermissionDeniedTool(
      hooks as unknown as import("../../automation.js").AutomationHooks,
    );
    const result = await handler({ tool: "Bash", reason: "blocked by policy" });
    expect(hooks.handlePermissionDenied).toHaveBeenCalledWith({
      tool: "Bash",
      reason: "blocked by policy",
    });
    expect(result).toMatchObject({
      content: [{ text: expect.stringContaining('"tool":"Bash"') }],
    });
  });
});
