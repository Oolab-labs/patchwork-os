import { describe, expect, it, vi } from "vitest";
import { createResumeClaudeTaskTool } from "../resumeClaudeTask.js";
import type { ClaudeOrchestrator, ClaudeTask } from "../../claudeOrchestrator.js";

function makeTask(overrides: Partial<ClaudeTask> = {}): ClaudeTask {
  return {
    id: "task-abc",
    sessionId: "session-1",
    prompt: "fix the bug",
    contextFiles: [],
    status: "done",
    createdAt: Date.now(),
    timeoutMs: 60_000,
    tokenEstimate: 10,
    ...overrides,
  };
}

function makeOrchestrator(task?: ClaudeTask) {
  return {
    getTask: vi.fn((id: string) => (id === task?.id ? task : undefined)),
    enqueue: vi.fn(() => "new-task-id"),
  } as unknown as ClaudeOrchestrator;
}

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("resumeClaudeTask", () => {
  it("returns error for empty taskId", async () => {
    const orch = makeOrchestrator();
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/non-empty/);
  });

  it("returns not-found when task does not exist", async () => {
    const orch = makeOrchestrator();
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "no-such-id" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/not found/i);
  });

  it("returns not-found when task belongs to a different session (auth isolation)", async () => {
    const task = makeTask({ id: "task-abc", sessionId: "session-other" });
    const orch = makeOrchestrator(task);
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBe(true);
    // Must return same "not found" message — must not reveal the task exists
    expect(parse(result).error).toMatch(/not found/i);
  });

  it("returns error when task is still pending", async () => {
    const task = makeTask({ status: "pending" });
    const orch = makeOrchestrator(task);
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/pending/);
  });

  it("returns error when task is still running", async () => {
    const task = makeTask({ status: "running" });
    const orch = makeOrchestrator(task);
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/running/);
  });

  it("re-enqueues a done task and returns new task id", async () => {
    const task = makeTask({ status: "done" });
    const orch = makeOrchestrator(task);
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(data.newTaskId).toBe("new-task-id");
    expect(data.originalTaskId).toBe("task-abc");
    expect(data.status).toBe("pending");
    expect(orch.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "fix the bug", sessionId: "session-1" }),
    );
  });

  it("re-enqueues a cancelled task", async () => {
    const task = makeTask({ status: "cancelled" });
    const orch = makeOrchestrator(task);
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBeUndefined();
    expect(orch.enqueue).toHaveBeenCalledOnce();
  });

  it("re-enqueues an errored task", async () => {
    const task = makeTask({ status: "error", errorMessage: "timeout" });
    const orch = makeOrchestrator(task);
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBeUndefined();
    expect(orch.enqueue).toHaveBeenCalledOnce();
  });

  it("returns error when enqueue throws (e.g. queue full)", async () => {
    const task = makeTask({ status: "done" });
    const orch = makeOrchestrator(task);
    (orch.enqueue as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("queue full");
    });
    const tool = createResumeClaudeTaskTool(orch, "session-1");
    const result = await tool.handler({ taskId: "task-abc" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/queue full/);
  });
});
