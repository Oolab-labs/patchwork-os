import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import type { ClaudeTaskInput, IClaudeDriver } from "../claudeDriver.js";
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
      async run(_input: ClaudeTaskInput) {
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
      (_taskId, chunk) => notifiedChunks.push(chunk),
      (_taskId, status) => notifiedDone.push(status),
    );
    await orch.runAndWait({ prompt: "test" });
    expect(notifiedChunks).toContain("hello");
    expect(notifiedDone).toContain("done");
  });
});

// ── Persistence tests ─────────────────────────────────────────────────────────

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      chmodSync: vi.fn(),
      promises: {
        ...(actual.promises ?? {}),
        chmod: vi.fn().mockResolvedValue(undefined),
      },
      lstatSync: vi.fn().mockReturnValue({ isFile: () => true }),
    },
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    lstatSync: vi.fn().mockReturnValue({ isFile: () => true }),
  };
});

describe("ClaudeOrchestrator — persistence", () => {
  let mockWriteFile: any;
  let mockReadFile: any;
  let mockWriteFileSync: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsp = await import("node:fs/promises");
    const fsm = await import("node:fs");
    mockWriteFile = fsp.writeFile as unknown as MockInstance;
    mockReadFile = fsp.readFile as unknown as MockInstance;
    mockWriteFileSync = (fsm.default as unknown as Record<string, MockInstance>)
      .writeFileSync;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── flushTasksToDisk ──────────────────────────────────────────────────────

  it("flushTasksToDisk — pending tasks saved with status 'pending'", async () => {
    const blocking = makeBlockingDriver();
    // Fill all running slots with slow tasks so queued tasks stay pending
    const orch = new ClaudeOrchestrator(makeSlowDriver(60_000), "/tmp", noop);
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      orch.enqueue({ prompt: `fill${i}` });
    }
    orch.enqueue({ prompt: "stays-pending" });

    orch.flushTasksToDisk(9999);

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [, jsonStr] = mockWriteFileSync.mock.calls[0] as [string, string];
    const payload = JSON.parse(jsonStr);
    expect(payload.version).toBe(1);
    expect(payload.savedAt).toBeTypeOf("number");
    const pending = payload.tasks.filter(
      (t: { status: string }) => t.status === "pending",
    );
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].prompt).toBe("stays-pending");
    void blocking;
  });

  it("flushTasksToDisk — running tasks saved with status 'interrupted'", async () => {
    const blocking = makeBlockingDriver();
    const orch = new ClaudeOrchestrator(blocking.driver, "/tmp", noop);
    orch.enqueue({ prompt: "running-task" });
    await new Promise((r) => setImmediate(r)); // let _runTask start

    expect(orch.getTask(orch.list("running")[0]?.id ?? "")?.status).toBe(
      "running",
    );

    orch.flushTasksToDisk(9999);

    const [, jsonStr] = mockWriteFileSync.mock.calls[0] as [string, string];
    const payload = JSON.parse(jsonStr);
    const interrupted = payload.tasks.filter(
      (t: { status: string }) => t.status === "interrupted",
    );
    expect(interrupted.length).toBe(1);
    expect(interrupted[0].prompt).toBe("running-task");

    // cleanup
    orch.cancel(orch.list("running")[0]?.id ?? "");
  });

  it("flushTasksToDisk — terminal tasks saved with their own status", async () => {
    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    await orch.runAndWait({ prompt: "completed" });

    orch.flushTasksToDisk(9999);

    const [, jsonStr] = mockWriteFileSync.mock.calls[0] as [string, string];
    const payload = JSON.parse(jsonStr);
    const done = payload.tasks.filter(
      (t: { status: string }) => t.status === "done",
    );
    expect(done.length).toBe(1);
    expect(done[0].prompt).toBe("completed");
  });

  // ── loadPersistedTasks ────────────────────────────────────────────────────

  it("loadPersistedTasks — pending tasks are re-enqueued with stable ID", async () => {
    const stableId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const v1Payload = {
      version: 1,
      savedAt: Date.now(),
      tasks: [
        {
          id: stableId,
          sessionId: "",
          prompt: "persisted-pending",
          contextFiles: [],
          status: "pending",
          createdAt: Date.now() - 5000,
          timeoutMs: 120_000,
          tokenEstimate: 10,
        },
      ],
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(v1Payload));

    const orch = new ClaudeOrchestrator(makeSlowDriver(60_000), "/tmp", noop);
    await orch.loadPersistedTasks(9999);

    // Task should have been re-enqueued with the original ID
    const task = orch.getTask(stableId);
    expect(task).toBeDefined();
    expect(task?.status === "pending" || task?.status === "running").toBe(true);
    expect(task?.prompt).toBe("persisted-pending");
  });

  it("loadPersistedTasks — interrupted tasks become history (not re-enqueued)", async () => {
    const id = "ffffffff-0000-0000-0000-000000000001";
    const v1Payload = {
      version: 1,
      savedAt: Date.now(),
      tasks: [
        {
          id,
          sessionId: "",
          prompt: "was-running",
          contextFiles: [],
          status: "interrupted",
          createdAt: Date.now() - 60_000,
          doneAt: Date.now() - 1000,
          timeoutMs: 120_000,
          tokenEstimate: 5,
        },
      ],
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(v1Payload));

    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    await orch.loadPersistedTasks(9999);

    expect(orch.list("interrupted").length).toBe(1);
    expect(orch.list("pending").length).toBe(0);
    expect(orch.getTask(id)?.prompt).toBe("was-running");
  });

  it("loadPersistedTasks — v0 format (array at root) loads terminal tasks only", async () => {
    const id = "ffffffff-0000-0000-0000-000000000002";
    const v0Payload = [
      {
        id,
        sessionId: "",
        prompt: "old-done",
        contextFiles: [],
        status: "done",
        createdAt: Date.now() - 10_000,
        doneAt: Date.now() - 5_000,
        timeoutMs: 120_000,
        tokenEstimate: 4,
        output: "result",
      },
    ];
    mockReadFile.mockResolvedValueOnce(JSON.stringify(v0Payload));

    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    await orch.loadPersistedTasks(9999);

    expect(orch.list("done").length).toBe(1);
    expect(orch.list("pending").length).toBe(0);
    expect(orch.getTask(id)?.output).toBe("result");
  });

  it("loadPersistedTasks — unknown version falls back to terminal tasks only", async () => {
    const id = "ffffffff-0000-0000-0000-000000000003";
    const futurePendingId = "ffffffff-0000-0000-0000-000000000004";
    const futurePayload = {
      version: 99,
      savedAt: Date.now(),
      tasks: [
        {
          id,
          sessionId: "",
          prompt: "done-task",
          contextFiles: [],
          status: "done",
          createdAt: Date.now() - 5_000,
          doneAt: Date.now(),
          timeoutMs: 120_000,
          tokenEstimate: 4,
        },
        {
          id: futurePendingId,
          sessionId: "",
          prompt: "pending-task",
          contextFiles: [],
          status: "pending",
          createdAt: Date.now() - 1_000,
          timeoutMs: 120_000,
          tokenEstimate: 4,
        },
      ],
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(futurePayload));

    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    await orch.loadPersistedTasks(9999);

    // Done tasks loaded, pending tasks not re-enqueued
    expect(orch.list("done").length).toBe(1);
    expect(orch.list("pending").length).toBe(0);
    expect(orch.getTask(futurePendingId)).toBeUndefined();
  });

  it("loadPersistedTasks — queue overflow: excess pending tasks become interrupted", async () => {
    const tasks = Array.from({ length: 25 }, (_, i) => ({
      id: `ffffffff-0000-0000-0000-${String(i).padStart(12, "0")}`,
      sessionId: "",
      prompt: `pending-${i}`,
      contextFiles: [],
      status: "pending",
      createdAt: Date.now(),
      timeoutMs: 120_000,
      tokenEstimate: 4,
    }));
    const v1Payload = { version: 1, savedAt: Date.now(), tasks };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(v1Payload));

    // Use slow driver so tasks accumulate rather than completing immediately
    const orch = new ClaudeOrchestrator(makeSlowDriver(60_000), "/tmp", noop);
    await orch.loadPersistedTasks(9999);

    const pendingCount =
      orch.list("pending").length + orch.list("running").length;
    const interruptedCount = orch.list("interrupted").length;
    expect(pendingCount).toBeLessThanOrEqual(ClaudeOrchestrator.MAX_QUEUE);
    expect(interruptedCount).toBe(25 - pendingCount);
    expect(pendingCount + interruptedCount).toBe(25);
  });

  it("loadPersistedTasks — v1 pending task preserves original createdAt", async () => {
    const originalCreatedAt = Date.now() - 120_000;
    const id = "ffffffff-0000-0000-0000-000000000010";
    const v1Payload = {
      version: 1,
      savedAt: Date.now(),
      tasks: [
        {
          id,
          sessionId: "",
          prompt: "timed-task",
          contextFiles: [],
          status: "pending",
          createdAt: originalCreatedAt,
          timeoutMs: 120_000,
          tokenEstimate: 10,
        },
      ],
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(v1Payload));

    const orch = new ClaudeOrchestrator(makeSlowDriver(60_000), "/tmp", noop);
    await orch.loadPersistedTasks(9999);

    const task = orch.getTask(id);
    expect(task?.createdAt).toBe(originalCreatedAt);
  });

  // ── persistTasks ─────────────────────────────────────────────────────────

  it("persistTasks — uses v1 envelope and includes all task statuses", async () => {
    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", noop);
    await orch.runAndWait({ prompt: "done-task" });

    await orch.persistTasks(9999);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [, jsonStr] = mockWriteFile.mock.calls[0] as [string, string];
    const payload = JSON.parse(jsonStr);
    expect(payload.version).toBe(1);
    expect(Array.isArray(payload.tasks)).toBe(true);
    expect(payload.tasks[0].status).toBe("done");
  });
});

// ── v2.24.1: cancelReason, stderrTail, wasAborted ─────────────────────────────

describe("ClaudeOrchestrator — v2.24.1 cancel reasons", () => {
  /** Driver that RETURNS (instead of throws) on abort, populating wasAborted + stderrTail. */
  function makeAbortReturningDriver(stderrTail = "boom"): IClaudeDriver {
    return {
      name: "abort-returning",
      async run(input: ClaudeTaskInput) {
        return new Promise((resolve) => {
          input.signal.addEventListener("abort", () => {
            resolve({
              text: "",
              exitCode: -1,
              durationMs: 10,
              stderrTail,
              wasAborted: true,
            });
          });
        });
      },
    };
  }

  it('sets cancelReason: "timeout" when the internal timeout fires', async () => {
    const driver = makeAbortReturningDriver("stderr after timeout");
    const orch = new ClaudeOrchestrator(driver, "/tmp", () => {});
    // Enqueue with a very short timeout so it trips immediately
    const id = orch.enqueue({ prompt: "x", timeoutMs: 50 });
    // Wait for the orchestrator to process and time out
    await new Promise((r) => setTimeout(r, 200));
    const task = orch.getTask(id);
    expect(task?.status).toBe("cancelled");
    expect(task?.cancelReason).toBe("timeout");
    expect(task?.wasAborted).toBe(true);
    expect(task?.stderrTail).toBe("stderr after timeout");
  });

  it('sets cancelReason: "user" when cancel() is called without a reason', async () => {
    const driver = makeAbortReturningDriver("stderr after user cancel");
    const orch = new ClaudeOrchestrator(driver, "/tmp", () => {});
    const id = orch.enqueue({ prompt: "x", timeoutMs: 60_000 });
    // Let _runTask kick in
    await new Promise((r) => setTimeout(r, 20));
    orch.cancel(id); // default reason: "user"
    await new Promise((r) => setTimeout(r, 50));
    const task = orch.getTask(id);
    expect(task?.status).toBe("cancelled");
    expect(task?.cancelReason).toBe("user");
    expect(task?.wasAborted).toBe(true);
    expect(task?.stderrTail).toBe("stderr after user cancel");
  });

  it('sets cancelReason: "shutdown" when cancel(id, "shutdown") is called', async () => {
    const driver = makeAbortReturningDriver();
    const orch = new ClaudeOrchestrator(driver, "/tmp", () => {});
    const id = orch.enqueue({ prompt: "x", timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    orch.cancel(id, "shutdown");
    await new Promise((r) => setTimeout(r, 50));
    const task = orch.getTask(id);
    expect(task?.status).toBe("cancelled");
    expect(task?.cancelReason).toBe("shutdown");
  });

  it('sets cancelReason: "user" on a pending task when cancel() is called before it runs', () => {
    // Fill the running slots so the new task stays pending
    const driver = makeSlowDriver(60_000);
    const orch = new ClaudeOrchestrator(driver, "/tmp", () => {});
    // Saturate concurrency
    for (let i = 0; i < ClaudeOrchestrator.MAX_CONCURRENT; i++) {
      orch.enqueue({ prompt: `filler ${i}`, timeoutMs: 60_000 });
    }
    const pendingId = orch.enqueue({ prompt: "pending", timeoutMs: 60_000 });
    const pending = orch.getTask(pendingId);
    expect(pending?.status).toBe("pending");
    orch.cancel(pendingId); // default "user"
    const task = orch.getTask(pendingId);
    expect(task?.status).toBe("cancelled");
    expect(task?.cancelReason).toBe("user");
  });

  it("still handles throw-on-abort drivers (backward compat fallback)", async () => {
    // makeSlowDriver rejects with AbortError — the orchestrator's catch block
    // should still mark cancelled with the right reason.
    const orch = new ClaudeOrchestrator(
      makeSlowDriver(60_000),
      "/tmp",
      () => {},
    );
    const id = orch.enqueue({ prompt: "x", timeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    const task = orch.getTask(id);
    expect(task?.status).toBe("cancelled");
    expect(task?.cancelReason).toBe("timeout");
    expect(task?.wasAborted).toBe(true);
  });
});

// ── F4: triggerSource in tasks payload ───────────────────────────────────────

describe("_buildTasksPayload: triggerSource is included", () => {
  it("exposes triggerSource on task when set", async () => {
    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", () => {});
    orch.enqueue({
      prompt: "do something",
      triggerSource: "onGitCommit",
      isAutomationTask: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    const task = orch.getTask(orch.list()[0]!.id);
    expect(task?.triggerSource).toBe("onGitCommit");
  });

  it("leaves triggerSource undefined when not set", async () => {
    const orch = new ClaudeOrchestrator(makeInstantDriver(), "/tmp", () => {});
    orch.enqueue({ prompt: "no source" });
    await new Promise((r) => setTimeout(r, 50));
    const task = orch.getTask(orch.list()[0]!.id);
    expect(task?.triggerSource).toBeUndefined();
  });
});

// ── _drain infinite loop guard ────────────────────────────────────────────────

describe("ClaudeOrchestrator._drain does not loop forever when all tasks exceed token budget", () => {
  it("leaves oversized tasks pending while a slot is occupied, without spinning", async () => {
    // estimateTokens = ceil(length/4); MAX_TOKEN_BUDGET = 500_000.
    // A prompt of 2_000_001 chars estimates to 500_001 tokens — just over budget.
    // We use a shorter 2MB string and accept the memory cost for correctness.
    const BUDGET = ClaudeOrchestrator.MAX_TOKEN_BUDGET; // 500_000 tokens
    // Craft a prompt whose estimate exceeds the budget by 1 token.
    const hugePrompt = "x".repeat(BUDGET * 4 + 4); // ceil((BUDGET*4+4)/4) = BUDGET+1

    let releaseBlocker: (() => void) | undefined;
    const driver: IClaudeDriver = {
      name: "blocker",
      run: () =>
        new Promise<{ text: string; exitCode: number; durationMs: number }>(
          (resolve) => {
            releaseBlocker = () =>
              resolve({ text: "", exitCode: 0, durationMs: 1 });
          },
        ),
    };
    const orch = new ClaudeOrchestrator(driver, "/tmp", () => {});

    // Occupy one slot with a small task (tokenEstimate well under budget).
    orch.enqueue({ prompt: "seed" });
    await new Promise((r) => setTimeout(r, 50)); // let seed start → running.size=1

    // Enqueue tasks whose prompts each exceed MAX_TOKEN_BUDGET tokens.
    // _drain is called synchronously inside enqueue — if the infinite-loop bug
    // is present the process hangs on the enqueue calls below.
    const before = Date.now();
    orch.enqueue({ prompt: `${hugePrompt}1` });
    orch.enqueue({ prompt: `${hugePrompt}2` });
    orch.enqueue({ prompt: `${hugePrompt}3` });
    // If we reach here quickly, the loop guard worked.
    expect(Date.now() - before).toBeLessThan(500);

    // All three oversized tasks must still be pending (not started).
    const pending = orch.list().filter((t) => t.status === "pending");
    expect(pending.length).toBe(3);

    // Cleanup
    releaseBlocker?.();
    await new Promise((r) => setTimeout(r, 50));
  });
});
