/**
 * Tests for cancelClaudeTask, getClaudeTaskStatus, listClaudeTasks.
 * Uses a minimal mock orchestrator — no real ClaudeOrchestrator needed.
 */

import { describe, expect, it } from "vitest";
import { createCancelClaudeTaskTool } from "../cancelClaudeTask.js";
import { createGetClaudeTaskStatusTool } from "../getClaudeTaskStatus.js";
import { createListClaudeTasksTool } from "../listClaudeTasks.js";

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

// ── Minimal orchestrator mock ─────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    sessionId: "session-A",
    status: "running",
    createdAt: Date.now(),
    startedAt: Date.now(),
    doneAt: undefined,
    output: undefined,
    errorMessage: undefined,
    timeoutMs: 30000,
    ...overrides,
  };
}

function makeOrchestrator(
  tasks: Record<string, ReturnType<typeof makeTask>> = {},
) {
  return {
    getTask: (id: string) => tasks[id] ?? null,
    cancel: (id: string) => {
      if (tasks[id]) {
        tasks[id].status = "cancelled";
        return true;
      }
      return false;
    },
    list: (status?: string) => {
      const all = Object.values(tasks);
      return status ? all.filter((t) => t.status === status) : all;
    },
  } as any;
}

// ── cancelClaudeTask ──────────────────────────────────────────────────────────

describe("cancelClaudeTask — validation", () => {
  const orch = makeOrchestrator();

  it("returns error when taskId is empty", async () => {
    const tool = createCancelClaudeTaskTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "" }));
    expect(result.error).toMatch(/non-empty/i);
  });

  it("returns error when taskId is not a string", async () => {
    const tool = createCancelClaudeTaskTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: 42 }));
    expect(result.error).toMatch(/non-empty/i);
  });
});

describe("cancelClaudeTask — task lookup and authorization", () => {
  it("returns error when task not found", async () => {
    const orch = makeOrchestrator();
    const tool = createCancelClaudeTaskTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "nonexistent" }));
    expect(result.error).toMatch(/not found/i);
  });

  it("returns error (as not found) when task belongs to different session", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({ sessionId: "session-B" }),
    });
    const tool = createCancelClaudeTaskTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    // Should look like "not found" to prevent session enumeration
    expect(result.error).toMatch(/not found/i);
  });

  it("cancels a task belonging to the caller's session", async () => {
    const orch = makeOrchestrator({ "task-1": makeTask() });
    const tool = createCancelClaudeTaskTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.cancelled).toBe(true);
    expect(result.taskId).toBe("task-1");
  });
});

// ── getClaudeTaskStatus ───────────────────────────────────────────────────────

describe("getClaudeTaskStatus — validation", () => {
  const orch = makeOrchestrator();

  it("returns error when taskId is empty", async () => {
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "  " }));
    expect(result.error).toMatch(/non-empty/i);
  });
});

describe("getClaudeTaskStatus — task lookup and authorization", () => {
  it("returns error when task not found", async () => {
    const orch = makeOrchestrator();
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "ghost" }));
    expect(result.error).toMatch(/not found/i);
  });

  it("returns error (as not found) when task belongs to different session", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({ sessionId: "session-B" }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.error).toMatch(/not found/i);
  });

  it("returns status for caller's own task", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({ status: "done", output: "Hello, world!" }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.taskId).toBe("task-1");
    expect(result.status).toBe("done");
    expect(result.output).toBe("Hello, world!");
  });

  it("truncates output to 500 chars", async () => {
    const longOutput = "x".repeat(600);
    const orch = makeOrchestrator({
      "task-1": makeTask({ output: longOutput }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.output).toHaveLength(500);
  });

  it("omits output field when task has no output", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({ output: undefined }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.output).toBeUndefined();
  });
});

// ── listClaudeTasks ───────────────────────────────────────────────────────────

describe("listClaudeTasks — validation", () => {
  const orch = makeOrchestrator();

  it("returns error for invalid status value", async () => {
    const tool = createListClaudeTasksTool(orch, "session-A");
    const result = parse(await tool.handler({ status: "invalid" }));
    expect(result.error).toMatch(/pending.*running.*done/i);
  });
});

describe("listClaudeTasks — session scoping and filtering", () => {
  const tasks = {
    "task-1": makeTask({
      id: "task-1",
      sessionId: "session-A",
      status: "done",
    }),
    "task-2": makeTask({
      id: "task-2",
      sessionId: "session-A",
      status: "running",
    }),
    "task-3": makeTask({
      id: "task-3",
      sessionId: "session-B",
      status: "done",
    }),
  };

  it("lists only tasks from caller's session", async () => {
    const orch = makeOrchestrator({ ...tasks });
    const tool = createListClaudeTasksTool(orch, "session-A");
    const result = parse(await tool.handler({}));
    expect(result.count).toBe(2);
    expect(result.tasks.map((t: any) => t.taskId)).not.toContain("task-3");
  });

  it("filters by status within caller's session", async () => {
    const orch = makeOrchestrator({ ...tasks });
    const tool = createListClaudeTasksTool(orch, "session-A");
    const result = parse(await tool.handler({ status: "done" }));
    expect(result.count).toBe(1);
    expect(result.tasks[0].taskId).toBe("task-1");
  });

  it("returns empty list when no tasks match", async () => {
    const orch = makeOrchestrator({ ...tasks });
    const tool = createListClaudeTasksTool(orch, "session-A");
    const result = parse(await tool.handler({ status: "cancelled" }));
    expect(result.count).toBe(0);
    expect(result.tasks).toHaveLength(0);
  });

  it("truncates output to 100 chars per task", async () => {
    const longOutput = "y".repeat(200);
    const orch = makeOrchestrator({
      "task-1": makeTask({ output: longOutput }),
    });
    const tool = createListClaudeTasksTool(orch, "session-A");
    const result = parse(await tool.handler({}));
    expect(result.tasks[0].output).toHaveLength(100);
  });

  it("omits output field when task has no output", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({ output: undefined }),
    });
    const tool = createListClaudeTasksTool(orch, "session-A");
    const result = parse(await tool.handler({}));
    expect(result.tasks[0].output).toBeUndefined();
  });
});
