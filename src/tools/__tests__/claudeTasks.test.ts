/**
 * Tests for cancelClaudeTask, getClaudeTaskStatus, listClaudeTasks.
 * Uses a minimal mock orchestrator — no real ClaudeOrchestrator needed.
 */

import { describe, expect, it, vi } from "vitest";
import { createCancelClaudeTaskTool } from "../cancelClaudeTask.js";
import { createGetClaudeTaskStatusTool } from "../getClaudeTaskStatus.js";
import { createListClaudeTasksTool } from "../listClaudeTasks.js";
import { createRunClaudeTaskTool } from "../runClaudeTask.js";

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

// ── runClaudeTask ─────────────────────────────────────────────────────────────

describe("runClaudeTask — effort/fallbackModel/maxBudgetUsd validation", () => {
  function makeEnqueueOrchestrator() {
    const enqueueOpts: Record<string, unknown>[] = [];
    return {
      orch: {
        enqueue: vi.fn((opts: Record<string, unknown>) => {
          enqueueOpts.push(opts);
          return "task-xyz";
        }),
      } as any,
      enqueueOpts,
    };
  }

  it("returns error when effort is invalid", async () => {
    const { orch } = makeEnqueueOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session-A", "/tmp");
    const result = parse(
      await tool.handler({ prompt: "hello", effort: "extreme" }),
    );
    expect(result.error).toMatch(/effort must be one of/i);
  });

  it("returns error when maxBudgetUsd is zero or negative", async () => {
    const { orch } = makeEnqueueOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session-A", "/tmp");
    const result = parse(
      await tool.handler({ prompt: "hello", maxBudgetUsd: -1 }),
    );
    expect(result.error).toMatch(/positive number/i);
  });

  it("forwards effort, fallbackModel, maxBudgetUsd to enqueue()", async () => {
    const { orch, enqueueOpts } = makeEnqueueOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session-A", "/tmp");
    const result = parse(
      await tool.handler({
        prompt: "hello",
        effort: "high",
        fallbackModel: "claude-haiku-4-5-20251001",
        maxBudgetUsd: 0.5,
      }),
    );
    expect(result.taskId).toBe("task-xyz");
    expect(enqueueOpts[0]).toMatchObject({
      effort: "high",
      fallbackModel: "claude-haiku-4-5-20251001",
      maxBudgetUsd: 0.5,
    });
  });

  it("omits effort/fallbackModel/maxBudgetUsd from enqueue() when not provided", async () => {
    const { orch, enqueueOpts } = makeEnqueueOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session-A", "/tmp");
    await tool.handler({ prompt: "hello" });
    expect(enqueueOpts[0]!.effort).toBeUndefined();
    expect(enqueueOpts[0]!.fallbackModel).toBeUndefined();
    expect(enqueueOpts[0]!.maxBudgetUsd).toBeUndefined();
  });
});

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

  it("adds resume hint when task cancelled due to timeout", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({
        status: "cancelled",
        cancelReason: "timeout",
        wasAborted: true,
      }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.cancelReason).toBe("timeout");
    expect(result.wasAborted).toBe(true);
    expect(result.hint).toMatch(/resumeClaudeTask/i);
  });

  it("omits hint when cancelled by user (not timeout)", async () => {
    const orch = makeOrchestrator({
      "task-1": makeTask({ status: "cancelled", cancelReason: "user" }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.cancelReason).toBe("user");
    expect(result.hint).toBeUndefined();
  });

  it("forwards stderrTail capped at 500 chars", async () => {
    const longStderr = "e".repeat(600);
    const orch = makeOrchestrator({
      "task-1": makeTask({ stderrTail: longStderr }),
    });
    const tool = createGetClaudeTaskStatusTool(orch, "session-A");
    const result = parse(await tool.handler({ taskId: "task-1" }));
    expect(result.stderrTail).toHaveLength(500);
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
