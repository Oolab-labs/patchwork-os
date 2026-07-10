import { describe, expect, it, vi } from "vitest";
import {
  createListVSCodeTasksTool,
  createRunVSCodeTaskTool,
} from "../vscodeTasks.js";

function parse(r: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}) {
  // Error results carry the plain message in `text` and machine-readable
  // fields in `structuredContent` (ADR-0004). Success results keep the
  // JSON-stringified payload in `text`.
  if (r.isError && r.structuredContent !== undefined)
    return r.structuredContent as any;
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

  // Bug: handleRunTask (extension side) returns a non-null {success:false}
  // object for task-not-found / exec-failure / internal-timeout. The old
  // bridge code only checked `result === null` before calling
  // successStructured(result) — so these real failures were reported as an
  // MCP-level tool SUCCESS (isError:false) with the failure buried in the
  // payload. A caller (or agent) that doesn't defensively check
  // result.structuredContent.success would believe the task ran/passed.
  describe("success:false extension responses must surface as real tool errors", () => {
    it("reports isError:true when the task is not found", async () => {
      const ext = {
        isConnected: () => true,
        runTask: vi
          .fn()
          .mockResolvedValue({ success: false, error: "Task not found: xyz" }),
      } as any;
      const tool = createRunVSCodeTaskTool(ext);
      const raw = await tool.handler({ name: "xyz" });
      expect((raw as any).isError).toBe(true);
      const result = parse(raw as any);
      expect(result.error).toContain("Task not found");
    });

    it("reports isError:true when the task times out", async () => {
      const ext = {
        isConnected: () => true,
        runTask: vi.fn().mockResolvedValue({
          success: false,
          name: "build",
          error: "Task timed out",
          timedOut: true,
        }),
      } as any;
      const tool = createRunVSCodeTaskTool(ext);
      const raw = await tool.handler({ name: "build" });
      expect((raw as any).isError).toBe(true);
      const result = parse(raw as any);
      expect(result.error).toContain("timed out");
      expect(result.timedOut).toBe(true);
    });

    it("reports isError:true when vscode.tasks.executeTask itself fails", async () => {
      const ext = {
        isConnected: () => true,
        runTask: vi.fn().mockResolvedValue({
          success: false,
          name: "build",
          error: "Failed to execute task: no workspace folder",
        }),
      } as any;
      const tool = createRunVSCodeTaskTool(ext);
      const raw = await tool.handler({ name: "build" });
      expect((raw as any).isError).toBe(true);
      const result = parse(raw as any);
      expect(result.error).toContain("Failed to execute task");
    });

    it("still reports isError:undefined (success) for a real success:true result", async () => {
      const ext = {
        isConnected: () => true,
        runTask: vi
          .fn()
          .mockResolvedValue({ success: true, name: "build", exitCode: 0 }),
      } as any;
      const tool = createRunVSCodeTaskTool(ext);
      const raw = await tool.handler({ name: "build" });
      expect((raw as any).isError).toBeUndefined();
      const result = parse(raw as any);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("still reports isError:undefined (success) for a completed task with a nonzero exit code (success:true)", async () => {
      // exitCode !== 0 with success:true means "the task ran to completion but
      // the underlying process failed" (e.g. lint/test failures) — this is
      // NOT the success:false bug path; it must remain a tool success with
      // exitCode surfaced, so the caller (agent) can inspect it. Confirms the
      // fix distinguishes "did the task run" from "did the task's command
      // exit 0" and doesn't overcorrect into flagging every nonzero exit.
      const ext = {
        isConnected: () => true,
        runTask: vi
          .fn()
          .mockResolvedValue({ success: true, name: "test", exitCode: 1 }),
      } as any;
      const tool = createRunVSCodeTaskTool(ext);
      const raw = await tool.handler({ name: "test" });
      expect((raw as any).isError).toBeUndefined();
      const result = parse(raw as any);
      expect(result.exitCode).toBe(1);
    });
  });
});
