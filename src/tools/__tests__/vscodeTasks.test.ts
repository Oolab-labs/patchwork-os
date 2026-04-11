import { describe, expect, it, vi } from "vitest";
import {
  createListVSCodeTasksTool,
  createRunVSCodeTaskTool,
} from "../vscodeTasks.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const disconnected = { isConnected: () => false } as any;

describe("listVSCodeTasks", () => {
  it("returns extensionRequired error when not connected", async () => {
    const tool = createListVSCodeTasksTool(disconnected);
    const result = parse(await tool.handler({}));
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/extension/i);
  });

  it("returns task list from extensionClient", async () => {
    const taskList = {
      tasks: [
        {
          name: "build",
          type: "npm",
          source: "Workspace",
          group: "build",
          detail: null,
        },
      ],
    };
    const ext = {
      isConnected: () => true,
      listTasks: vi.fn().mockResolvedValue(taskList),
    } as any;
    const tool = createListVSCodeTasksTool(ext);
    const result = parse(await tool.handler({}));
    expect(ext.listTasks).toHaveBeenCalledOnce();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe("build");
  });

  it("returns error when extensionClient returns null", async () => {
    const ext = {
      isConnected: () => true,
      listTasks: vi.fn().mockResolvedValue(null),
    } as any;
    const tool = createListVSCodeTasksTool(ext);
    const result = parse(await tool.handler({}));
    expect(result.error).toBeDefined();
  });

  it("has readOnlyHint annotation", () => {
    const tool = createListVSCodeTasksTool(disconnected);
    expect((tool.schema.annotations as any).readOnlyHint).toBe(true);
  });

  it("schema description is 200 chars or fewer", () => {
    const tool = createListVSCodeTasksTool(disconnected);
    expect(tool.schema.description.length).toBeLessThanOrEqual(200);
  });
});

describe("runVSCodeTask", () => {
  it("returns extensionRequired error when not connected", async () => {
    const tool = createRunVSCodeTaskTool(disconnected);
    const result = parse(await tool.handler({ name: "build" }));
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/extension/i);
  });

  it("throws when name is missing (requireString contract)", async () => {
    const ext = { isConnected: () => true, runTask: vi.fn() } as any;
    const tool = createRunVSCodeTaskTool(ext);
    await expect(tool.handler({})).rejects.toThrow(/name must be a string/i);
    expect(ext.runTask).not.toHaveBeenCalled();
  });

  it("calls extensionClient.runTask with correct args", async () => {
    const taskResult = { success: true, name: "build", exitCode: 0 };
    const ext = {
      isConnected: () => true,
      runTask: vi.fn().mockResolvedValue(taskResult),
    } as any;
    const tool = createRunVSCodeTaskTool(ext);
    const result = parse(
      await tool.handler({ name: "build", type: "npm", timeout: 30 }),
    );
    expect(ext.runTask).toHaveBeenCalledWith("build", "npm", 30_000);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("uses default 60s timeout when not specified", async () => {
    const taskResult = { success: true, name: "build", exitCode: 0 };
    const ext = {
      isConnected: () => true,
      runTask: vi.fn().mockResolvedValue(taskResult),
    } as any;
    const tool = createRunVSCodeTaskTool(ext);
    await tool.handler({ name: "build" });
    expect(ext.runTask).toHaveBeenCalledWith("build", undefined, 60_000);
  });

  it("has destructiveHint annotation", () => {
    const tool = createRunVSCodeTaskTool(disconnected);
    expect((tool.schema.annotations as any).destructiveHint).toBe(true);
  });

  it("schema description is 200 chars or fewer", () => {
    const tool = createRunVSCodeTaskTool(disconnected);
    expect(tool.schema.description.length).toBeLessThanOrEqual(200);
  });

  it("has timeoutMs of 610000", () => {
    const tool = createRunVSCodeTaskTool(disconnected);
    expect((tool as any).timeoutMs).toBe(610_000);
  });
});
