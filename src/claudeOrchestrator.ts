import { randomUUID } from "node:crypto";
import type { IClaudeDriver } from "./claudeDriver.js";

export type TaskStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface ClaudeTask {
  id: string;
  sessionId: string;
  prompt: string;
  contextFiles: string[];
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  doneAt?: number;
  /** Full output text, capped at 50KB. */
  output?: string;
  errorMessage?: string;
  timeoutMs: number;
}

export type EnqueueOpts = {
  prompt: string;
  contextFiles?: string[];
  timeoutMs?: number;
  sessionId?: string;
  onChunk?: (chunk: string) => void;
};

export class ClaudeOrchestrator {
  static readonly MAX_CONCURRENT = 10;
  static readonly MAX_QUEUE = 20;
  static readonly MAX_HISTORY = 100;
  static readonly DEFAULT_TIMEOUT_MS = 120_000;

  private tasks = new Map<string, ClaudeTask>();
  /** Per-task streaming callback (set by callers of enqueue/runAndWait). */
  private taskCallbacks = new Map<string, (chunk: string) => void>();
  /** Per-task completion callbacks (set by runAndWait). */
  private completionCallbacks = new Map<string, (task: ClaudeTask) => void>();
  private queue: string[] = [];
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private readonly driver: IClaudeDriver,
    private readonly workspace: string,
    private readonly log: (msg: string) => void,
    /** Called for each stdout chunk of every task (for VS Code output channel). */
    private readonly notifyChunk?: (taskId: string, chunk: string) => void,
    /** Called when a task reaches a terminal state. */
    private readonly notifyDone?: (taskId: string, status: TaskStatus) => void,
  ) {}

  /**
   * Enqueue a task and return its ID immediately.
   * The task will start running as soon as a concurrent slot is available.
   */
  enqueue(opts: EnqueueOpts): string {
    const id = randomUUID();
    this._enqueueWithId(id, opts);
    return id;
  }

  private _enqueueWithId(id: string, opts: EnqueueOpts): void {
    if (this.queue.length + this.running.size >= ClaudeOrchestrator.MAX_QUEUE) {
      // Clean up the pre-registered completion callback if we can't enqueue
      this.completionCallbacks.delete(id);
      throw new Error(
        `Task queue is full (max ${ClaudeOrchestrator.MAX_QUEUE} pending+running tasks)`,
      );
    }

    const task: ClaudeTask = {
      id,
      sessionId: opts.sessionId ?? "",
      prompt: opts.prompt,
      contextFiles: opts.contextFiles ?? [],
      status: "pending",
      createdAt: Date.now(),
      timeoutMs: opts.timeoutMs ?? ClaudeOrchestrator.DEFAULT_TIMEOUT_MS,
    };

    this.tasks.set(id, task);
    if (opts.onChunk) this.taskCallbacks.set(id, opts.onChunk);
    this.queue.push(id);
    this.log(`[orchestrator] enqueued task ${id.slice(0, 8)}`);
    this._drain();
  }

  /**
   * Enqueue a task and wait until it reaches a terminal state (done/error/cancelled).
   * The returned Promise always settles — the task's own timeoutMs is the upper bound.
   */
  async runAndWait(opts: EnqueueOpts): Promise<ClaudeTask> {
    // Register the completion callback BEFORE calling _enqueueWithId() (which calls _drain()).
    // If the driver is synchronous/instant, the task may reach a terminal state inside
    // _drain() before we ever set the callback — resulting in a Promise that never settles.
    // By pre-registering under a stable ID we avoid that race entirely.
    const id = randomUUID();
    return new Promise((resolve) => {
      this.completionCallbacks.set(id, resolve);
      this._enqueueWithId(id, opts);
    });
  }

  getTask(id: string): ClaudeTask | undefined {
    return this.tasks.get(id);
  }

  list(status?: TaskStatus): ClaudeTask[] {
    const all = [...this.tasks.values()];
    if (status === undefined) return all;
    return all.filter((t) => t.status === status);
  }

  /**
   * Cancel a pending or running task.
   * Returns true if the task was found and cancellation was initiated.
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "pending") {
      task.status = "cancelled";
      task.doneAt = Date.now();
      this.queue = this.queue.filter((qid) => qid !== id);
      this._fireCompletion(id);
      this.log(`[orchestrator] cancelled pending task ${id.slice(0, 8)}`);
      return true;
    }
    if (task.status === "running") {
      this.controllers.get(id)?.abort();
      this.log(`[orchestrator] aborting running task ${id.slice(0, 8)}`);
      return true;
    }
    return false;
  }

  private _drain(): void {
    while (
      this.running.size < ClaudeOrchestrator.MAX_CONCURRENT &&
      this.queue.length > 0
    ) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.status !== "pending") continue;
      this._runTask(id);
    }
  }

  private async _runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;

    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.running.add(id);
    task.status = "running";
    task.startedAt = Date.now();
    this.log(`[orchestrator] starting task ${id.slice(0, 8)}`);

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, task.timeoutMs);

    try {
      const result = await this.driver.run({
        prompt: task.prompt,
        contextFiles: task.contextFiles,
        workspace: this.workspace,
        timeoutMs: task.timeoutMs,
        signal: controller.signal,
        onChunk: (chunk: string) => {
          // Per-task streaming callback (e.g. for MCP notifications/progress)
          this.taskCallbacks.get(id)?.(chunk);
          // Global chunk notification (for VS Code output channel)
          this.notifyChunk?.(id, chunk);
        },
      });

      task.output = result.text;
      task.status = result.exitCode === 0 ? "done" : "error";
      if (result.exitCode !== 0) {
        task.errorMessage = `Process exited with code ${result.exitCode}`;
      }
    } catch (err) {
      if (
        (err instanceof Error && err.name === "AbortError") ||
        controller.signal.aborted
      ) {
        task.status = "cancelled";
      } else {
        task.status = "error";
        task.errorMessage = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timeoutHandle);
      task.doneAt = Date.now();
      this.running.delete(id);
      this.controllers.delete(id);
      this.taskCallbacks.delete(id);
      this.log(
        `[orchestrator] task ${id.slice(0, 8)} finished: ${task.status} (${task.doneAt - (task.startedAt ?? task.doneAt)}ms)`,
      );

      this.notifyDone?.(id, task.status);
      this._fireCompletion(id);
      this._drain();
      this._pruneHistory();
    }
  }

  private _fireCompletion(id: string): void {
    const cb = this.completionCallbacks.get(id);
    if (cb) {
      this.completionCallbacks.delete(id);
      const task = this.tasks.get(id);
      if (task) cb(task);
    }
  }

  private _pruneHistory(): void {
    if (this.tasks.size <= ClaudeOrchestrator.MAX_HISTORY) return;
    // Remove oldest terminal tasks until we're at MAX_HISTORY
    const terminal = [...this.tasks.values()]
      .filter(
        (t) =>
          t.status === "done" ||
          t.status === "error" ||
          t.status === "cancelled",
      )
      .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));

    const toRemove = this.tasks.size - ClaudeOrchestrator.MAX_HISTORY;
    for (let i = 0; i < toRemove && i < terminal.length; i++) {
      const entry = terminal[i];
      if (entry) this.tasks.delete(entry.id);
    }
  }
}
