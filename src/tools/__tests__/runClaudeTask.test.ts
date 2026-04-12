import os from "node:os";
import { describe, expect, it } from "vitest";
import type { IClaudeDriver } from "../../claudeDriver.js";
import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import { createCancelClaudeTaskTool } from "../cancelClaudeTask.js";
import { createGetClaudeTaskStatusTool } from "../getClaudeTaskStatus.js";
import { createListClaudeTasksTool } from "../listClaudeTasks.js";
import { createRunClaudeTaskTool } from "../runClaudeTask.js";

function makeOrchestrator(driver?: IClaudeDriver) {
  const d: IClaudeDriver = driver ?? {
    name: "instant",
    async run() {
      return { text: "result", exitCode: 0, durationMs: 1 };
    },
  };
  return new ClaudeOrchestrator(d, os.tmpdir(), () => {});
}

function resultText(result: any): string {
  return result.content[0]?.text ?? "";
}

function resultData(result: any): unknown {
  return JSON.parse(resultText(result));
}

describe("runClaudeTask", () => {
  it("returns taskId and pending status", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const result = await tool.handler({ prompt: "hello" });
    expect(result.isError).toBeUndefined();
    const data = resultData(result) as { taskId: string; status: string };
    expect(typeof data.taskId).toBe("string");
    expect(data.status).toBe("pending");
  });

  it("rejects missing prompt", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });

  it("rejects empty prompt", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const result = await tool.handler({ prompt: "   " });
    expect(result.isError).toBe(true);
  });

  it("rejects contextFiles outside workspace", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const result = await tool.handler({
      prompt: "hello",
      contextFiles: ["/etc/passwd"],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("workspace_escape");
  });

  it("rejects too many contextFiles", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const result = await tool.handler({
      prompt: "hello",
      contextFiles: Array(21).fill("a.ts"),
    });
    expect(result.isError).toBe(true);
  });

  it("rejects invalid timeoutMs", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const result = await tool.handler({ prompt: "hello", timeoutMs: 100 });
    expect(result.isError).toBe(true);
  });

  it("stream=true blocks and returns output", async () => {
    const chunkDriver: IClaudeDriver = {
      name: "chunk",
      async run(input) {
        input.onChunk?.("result");
        return { text: "result", exitCode: 0, durationMs: 1 };
      },
    };
    const orch = makeOrchestrator(chunkDriver);
    const tool = createRunClaudeTaskTool(orch, "session1", os.tmpdir());
    const chunks: string[] = [];
    const progressFn = (_: number, __?: number, msg?: string) => {
      if (msg) chunks.push(msg);
    };
    const result = await tool.handler(
      { prompt: "hello", stream: true },
      undefined,
      progressFn,
    );
    expect(result.isError).toBeUndefined();
    const data = resultData(result) as { status: string; output: string };
    expect(data.status).toBe("done");
    expect(chunks).toContain("result");
  });
});

describe("getClaudeTaskStatus", () => {
  it("returns task object", async () => {
    const orch = makeOrchestrator();
    const runTool = createRunClaudeTaskTool(orch, "s1", os.tmpdir());
    const statusTool = createGetClaudeTaskStatusTool(orch, "s1");
    const runResult = await runTool.handler({ prompt: "test" });
    const { taskId } = resultData(runResult) as { taskId: string };

    const statusResult = await statusTool.handler({ taskId });
    expect(statusResult.isError).toBeUndefined();
    const data = resultData(statusResult) as { taskId: string };
    expect(data.taskId).toBe(taskId);
  });

  it("returns isError + task_not_found for unknown taskId", async () => {
    const orch = makeOrchestrator();
    const tool = createGetClaudeTaskStatusTool(orch);
    const result = await tool.handler({ taskId: "nonexistent-id" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("task_not_found");
  });
});

describe("cancelClaudeTask", () => {
  it("returns cancelled: true for pending task", async () => {
    // Use a slow driver so the task stays pending/running
    const slowDriver: IClaudeDriver = {
      name: "slow",
      async run(input) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          input.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(
              Object.assign(new Error("AbortError"), { name: "AbortError" }),
            );
          });
        });
        return { text: "", exitCode: 0, durationMs: 0 };
      },
    };

    // Fill slots so our task stays pending
    const orch = new ClaudeOrchestrator(slowDriver, os.tmpdir(), () => {});
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      orch.enqueue({ prompt: `fill${i}` });
    }
    const runTool = createRunClaudeTaskTool(orch, "s1", os.tmpdir());
    const cancelTool = createCancelClaudeTaskTool(orch, "s1");
    const runResult = await runTool.handler({ prompt: "to cancel" });
    const { taskId } = resultData(runResult) as { taskId: string };

    const cancelResult = await cancelTool.handler({ taskId });
    expect(cancelResult.isError).toBeUndefined();
    const data = resultData(cancelResult) as { cancelled: boolean };
    expect(data.cancelled).toBe(true);
  });

  it("returns task_not_found for unknown taskId", async () => {
    const orch = makeOrchestrator();
    const tool = createCancelClaudeTaskTool(orch);
    const result = await tool.handler({ taskId: "unknown" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("task_not_found");
  });
});

describe("listClaudeTasks", () => {
  it("lists all tasks without filter", async () => {
    const orch = makeOrchestrator();
    const runTool = createRunClaudeTaskTool(orch, "s1", os.tmpdir());
    const listTool = createListClaudeTasksTool(orch, "s1");

    await runTool.handler({ prompt: "task1" });
    await runTool.handler({ prompt: "task2" });

    const result = await listTool.handler({});
    expect(result.isError).toBeUndefined();
    const data = resultData(result) as { count: number; tasks: unknown[] };
    expect(data.count).toBe(2);
    expect(data.tasks.length).toBe(2);
  });

  it("filters by status", async () => {
    const orch = makeOrchestrator();
    const listTool = createListClaudeTasksTool(orch, "s1");
    await orch.runAndWait({ prompt: "done task", sessionId: "s1" });

    const result = await listTool.handler({ status: "done" });
    const data = resultData(result) as { count: number; tasks: unknown[] };
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  it("rejects invalid status filter", async () => {
    const orch = makeOrchestrator();
    const tool = createListClaudeTasksTool(orch);
    const result = await tool.handler({ status: "bogus" });
    expect(result.isError).toBe(true);
  });
});

describe("runClaudeTask systemPrompt validation", () => {
  it("accepts valid systemPrompt and stores it on the task", async () => {
    let capturedSystemPrompt: string | undefined;
    const driver: IClaudeDriver = {
      name: "capture",
      async run(input) {
        capturedSystemPrompt = (input as any).systemPrompt;
        return { text: "ok", exitCode: 0, durationMs: 1 };
      },
    };
    const orch = makeOrchestrator(driver);
    const tool = createRunClaudeTaskTool(orch, "s1", os.tmpdir());
    const result = await tool.handler({
      prompt: "hello",
      systemPrompt: "Be concise.",
    });
    expect(result.isError).toBeUndefined();
    // Task stores systemPrompt
    const { taskId } = resultData(result) as { taskId: string };
    const task = orch.list().find((t) => t.id === taskId);
    expect(task?.systemPrompt).toBe("Be concise.");
  });

  it("rejects systemPrompt exceeding 4096 chars", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "s1", os.tmpdir());
    const result = await tool.handler({
      prompt: "hello",
      systemPrompt: "x".repeat(4097),
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/systemPrompt/);
  });

  it("accepts systemPrompt at exactly 4096 chars", async () => {
    const orch = makeOrchestrator();
    const tool = createRunClaudeTaskTool(orch, "s1", os.tmpdir());
    const result = await tool.handler({
      prompt: "hello",
      systemPrompt: "x".repeat(4096),
    });
    expect(result.isError).toBeUndefined();
  });
});
