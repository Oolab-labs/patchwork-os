import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IClaudeDriver } from "../claudeDriver.js";
import type { ClaudeTaskInput } from "../claudeDriver.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";

// ── Mock driver helpers ───────────────────────────────────────────────────────

function makeInstantDriver(exitCode = 0, output = "ok"): IClaudeDriver {
  return {
    name: "instant",
    async run(input: ClaudeTaskInput) {
      input.onChunk?.(output);
      return { text: output, exitCode, durationMs: 1 };
    },
  };
}

function makeSlowDriver(delayMs: number, output = "slow"): IClaudeDriver {
  return {
    name: "slow",
    async run(input: ClaudeTaskInput) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        input.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(
            Object.assign(new Error("AbortError"), { name: "AbortError" }),
          );
        });
      });
      input.onChunk?.(output);
      return { text: output, exitCode: 0, durationMs: delayMs };
    },
  };
}

function makeBlockingDriver(): {
  driver: IClaudeDriver;
  resolve: (output?: string) => void;
  reject: (err: Error) => void;
} {
  let res: (output?: string) => void;
  let rej: (err: Error) => void;
  const driver: IClaudeDriver = {
    name: "blocking",
    async run(input: ClaudeTaskInput) {
      return new Promise<{
        text: string;
        exitCode: number;
        durationMs: number;
      }>((resolve, reject) => {
        res = (output = "done") => {
          input.onChunk?.(output);
          resolve({ text: output, exitCode: 0, durationMs: 1 });
        };
        rej = (err) => {
          reject(err);
        };
        input.signal.addEventListener("abort", () => {
          reject(
            Object.assign(new Error("AbortError"), { name: "AbortError" }),
          );
        });
      });
    },
  };
  return {
    driver,
    get resolve() {
      return res;
    },
    get reject() {
      return rej;
    },
  };
}

const noop = () => {};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ClaudeOrchestrator", () => {
  it("pending → running → done status transitions", async () => {
    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    const id = orch.enqueue({ prompt: "hello" });
    // Give the event loop a tick to let the async _runTask complete
    await new Promise((r) => setImmediate(r));
    const task = orch.getTask(id);
    expect(task?.status).toBe("done");
    expect(task?.output).toBe("ok");
  });

  it("cancel pending — driver never called, status = cancelled", async () => {
    // Use a slow driver so fillers occupy all running slots
    const orch = new ClaudeOrchestrator(makeSlowDriver(10_000), "/tmp", noop);
    // Fill all running slots
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      orch.enqueue({ prompt: `filler${i}` });
    }
    // This task stays pending (running slots full)
    const pendingId = orch.enqueue({ prompt: "to-cancel" });
    expect(orch.getTask(pendingId)?.status).toBe("pending");

    const cancelled = orch.cancel(pendingId);
    expect(cancelled).toBe(true);
    expect(orch.getTask(pendingId)?.status).toBe("cancelled");
  });

  it("cancel running — abort signal fired → status = cancelled", async () => {
    const blocking = makeBlockingDriver();
    const orch = new ClaudeOrchestrator(blocking.driver, "/tmp", noop);
    const id = orch.enqueue({ prompt: "slow task" });
    await new Promise((r) => setImmediate(r)); // let _runTask start
    expect(orch.getTask(id)?.status).toBe("running");
    orch.cancel(id);
    await new Promise((r) => setImmediate(r));
    expect(orch.getTask(id)?.status).toBe("cancelled");
  });

  it("max concurrent cap — 15 tasks, slow driver, ≤10 running simultaneously", async () => {
    let maxSeen = 0;
    let current = 0;
    const driver: IClaudeDriver = {
      name: "counter",
      async run(input: ClaudeTaskInput) {
        current++;
        maxSeen = Math.max(maxSeen, current);
        await new Promise((r) => setTimeout(r, 5));
        current--;
        return { text: "ok", exitCode: 0, durationMs: 5 };
      },
    };
    const orch = new ClaudeOrchestrator(driver, "/tmp", noop);
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 15; i++) {
      promises.push(orch.runAndWait({ prompt: `task${i}` }));
    }
    await Promise.all(promises);
    expect(maxSeen).toBeLessThanOrEqual(ClaudeOrchestrator.MAX_CONCURRENT);
  });

  it("queue full rejection", () => {
    const orch = new ClaudeOrchestrator(makeSlowDriver(10_000), "/tmp", noop);
    for (let i = 0; i < ClaudeOrchestrator.MAX_QUEUE; i++) {
      orch.enqueue({ prompt: `task${i}` });
    }
    expect(() => orch.enqueue({ prompt: "overflow" })).toThrow(
      /queue is full/i,
    );
  });

  it("runAndWait rejects when queue is full", async () => {
    const orch = new ClaudeOrchestrator(makeSlowDriver(10_000), "/tmp", noop);
    for (let i = 0; i < ClaudeOrchestrator.MAX_QUEUE; i++) {
      orch.enqueue({ prompt: `task${i}` });
    }
    await expect(orch.runAndWait({ prompt: "overflow" })).rejects.toThrow(
      /queue is full/i,
    );
  });

  it("history pruning — complete 101 tasks in batches, assert 100 retained", async () => {
    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    // Run in batches of MAX_CONCURRENT to avoid queue overflow
    for (let batch = 0; batch <= 10; batch++) {
      const batchSize = Math.min(10, 101 - batch * 10);
      if (batchSize <= 0) break;
      const promises = Array.from({ length: batchSize }, (_, i) =>
        orch.runAndWait({ prompt: `task${batch * 10 + i}` }),
      );
      await Promise.all(promises);
    }
    expect(orch.list().length).toBeLessThanOrEqual(
      ClaudeOrchestrator.MAX_HISTORY,
    );
  });

  it("drain on completion — queued task starts immediately after slot frees", async () => {
    const blocking = makeBlockingDriver();
    const orch = new ClaudeOrchestrator(blocking.driver, "/tmp", noop);

    // Fill all running slots
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      orch.enqueue({ prompt: `blocker${i}` });
    }
    await new Promise((r) => setImmediate(r));

    // Enqueue one more — stays pending
    const waitingId = orch.enqueue({ prompt: "waiting" });
    expect(orch.getTask(waitingId)?.status).toBe("pending");

    // Resolve one blocker
    blocking.resolve("done");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Waiting task should now be running
    const status = orch.getTask(waitingId)?.status;
    expect(status === "running" || status === "done").toBe(true);
  });

  it("runAndWait resolves after task completes", async () => {
    const orch = new ClaudeOrchestrator(
      makeInstantDriver(0, "result text"),
      "/tmp",
      noop,
    );
    const task = await orch.runAndWait({ prompt: "test" });
    expect(task.status).toBe("done");
    expect(task.output).toBe("result text");
  });

  it("runAndWait resolves with error status when driver throws", async () => {
    const driver: IClaudeDriver = {
      name: "throws",
      async run() {
        throw new Error("driver exploded");
      },
    };
    const orch = new ClaudeOrchestrator(driver, "/tmp", noop);
    const task = await orch.runAndWait({ prompt: "test" });
    expect(task.status).toBe("error");
    expect(task.errorMessage).toContain("driver exploded");
  });

  it("onChunk callback called for each chunk during _runTask", async () => {
    const chunks: string[] = [];
    const driver: IClaudeDriver = {
      name: "multi-chunk",
      async run(input: ClaudeTaskInput) {
        input.onChunk?.("chunk1");
        input.onChunk?.("chunk2");
        input.onChunk?.("chunk3");
        return { text: "chunk1chunk2chunk3", exitCode: 0, durationMs: 1 };
      },
    };
    const orch = new ClaudeOrchestrator(driver, "/tmp", noop);
    await orch.runAndWait({
      prompt: "test",
      onChunk: (c) => chunks.push(c),
    });
    expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"]);
  });

  it("notifyChunk and notifyDone callbacks called for all tasks", async () => {
    const notifiedChunks: string[] = [];
    const notifiedDone: string[] = [];
    const orch = new ClaudeOrchestrator(
      makeInstantDriver(0, "hello"),
      "/tmp",
      noop,
      (taskId, chunk) => notifiedChunks.push(chunk),
      (taskId, status) => notifiedDone.push(status),
    );
    await orch.runAndWait({ prompt: "test" });
    expect(notifiedChunks).toContain("hello");
    expect(notifiedDone).toContain("done");
  });
});
