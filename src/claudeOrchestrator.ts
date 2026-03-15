import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
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
  /** Estimated token count for the prompt (used for token-budget concurrency). */
  tokenEstimate: number;
  /** Optional model override passed to the driver (e.g. "claude-haiku-4-5-20251001"). */
  model?: string;
}

/** Fast heuristic: ~4 chars per token for English code. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type EnqueueOpts = {
  prompt: string;
  contextFiles?: string[];
  timeoutMs?: number;
  sessionId?: string;
  onChunk?: (chunk: string) => void;
  /** Optional model override, e.g. "claude-haiku-4-5-20251001". */
  model?: string;
};

export class ClaudeOrchestrator {
  static readonly MAX_CONCURRENT = 10;
  static readonly MAX_QUEUE = 20;
  static readonly MAX_HISTORY = 100;
  static readonly DEFAULT_TIMEOUT_MS = 120_000;
  /** Maximum total estimated tokens in-flight across all running tasks. */
  static readonly MAX_TOKEN_BUDGET = 500_000;

  private tasks = new Map<string, ClaudeTask>();
  /** Per-task streaming callback (set by callers of enqueue/runAndWait). */
  private taskCallbacks = new Map<string, (chunk: string) => void>();
  /** Per-task completion callbacks (set by runAndWait). */
  private completionCallbacks = new Map<string, (task: ClaudeTask) => void>();
  private queue: string[] = [];
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();
  /** Sum of tokenEstimate for all currently-running tasks. */
  private _activeTokens = 0;

  /** Current total estimated tokens in-flight across all running tasks. */
  get activeTokens(): number {
    return this._activeTokens;
  }

  constructor(
    private readonly driver: IClaudeDriver,
    private readonly workspace: string,
    private readonly log: (msg: string) => void,
    /** Called for each stdout chunk of every task (for VS Code output channel). */
    private readonly notifyChunk?: (taskId: string, chunk: string) => void,
    /** Called when a task reaches a terminal state. */
    private readonly notifyDone?: (taskId: string, status: TaskStatus) => void,
    /** Optional checkpoint to save after each task completes or fails. */
    private readonly checkpoint?: { save(): void | Promise<void> },
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
      tokenEstimate: estimateTokens(opts.prompt),
      ...(opts.model !== undefined && { model: opts.model }),
    };

    this.tasks.set(id, task);
    if (opts.onChunk) this.taskCallbacks.set(id, opts.onChunk);
    this.queue.push(id);
    this.log(`[orchestrator] enqueued task ${id.slice(0, 8)}`);
    this._drain();
  }

  /**
   * Enqueue a task and wait until it reaches a terminal state (done/error/cancelled).
   * The returned Promise always resolves (never rejects) — check task.status for the outcome.
   * The task's own timeoutMs is the upper bound on how long this can take.
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
      const id = this.queue[0];
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.status !== "pending") {
        this.queue.shift();
        continue;
      }
      // Token-budget check: if adding this task would exceed the budget, skip it
      // for now so smaller tasks behind it can still run (if concurrency slots exist).
      // Only break if we've already hit MAX_CONCURRENT (no slots to fill anyway).
      if (
        this.running.size > 0 &&
        this._activeTokens + task.tokenEstimate >
          ClaudeOrchestrator.MAX_TOKEN_BUDGET
      ) {
        if (this.running.size >= ClaudeOrchestrator.MAX_CONCURRENT) break;
        // Concurrency slots available — skip this oversized task and try the next one.
        this.queue.shift();
        this.queue.push(id); // move to back of queue
        continue;
      }
      this.queue.shift();
      this._runTask(id);
    }
  }

  private async _runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;

    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.running.add(id);
    this._activeTokens += task.tokenEstimate;
    task.status = "running";
    task.startedAt = Date.now();
    this.log(
      `[orchestrator] starting task ${id.slice(0, 8)} (~${task.tokenEstimate} tokens, ${this._activeTokens} in-flight)`,
    );

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
        model: task.model,
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
      this._activeTokens = Math.max(0, this._activeTokens - task.tokenEstimate);
      this.controllers.delete(id);
      this.taskCallbacks.delete(id);
      this.log(
        `[orchestrator] task ${id.slice(0, 8)} finished: ${task.status} (${task.doneAt - (task.startedAt ?? task.doneAt)}ms)`,
      );

      this.notifyDone?.(id, task.status);
      this._fireCompletion(id);
      void Promise.resolve(this.checkpoint?.save()).catch(() => {
        /* best-effort */
      });
      this._drain();
      this._pruneHistory();
    }
  }

  private _fireCompletion(id: string): void {
    const cb = this.completionCallbacks.get(id);
    if (cb) {
      this.completionCallbacks.delete(id);
      const task = this.tasks.get(id);
      if (task) {
        try {
          cb(task);
        } catch (err) {
          this.log(
            `[orchestrator] completion callback for task ${id.slice(0, 8)} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /** Persist terminal tasks to disk for cross-session resumability. Best-effort. */
  async persistTasks(port: number): Promise<void> {
    const filePath = join(homedir(), ".claude", "ide", `tasks-${port}.json`);
    const toSave = [...this.tasks.values()]
      .filter(
        (t) =>
          t.status === "done" ||
          t.status === "error" ||
          t.status === "cancelled",
      )
      .map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        prompt: t.prompt,
        contextFiles: t.contextFiles,
        status: t.status,
        output: t.output,
        errorMessage: t.errorMessage,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        doneAt: t.doneAt,
        timeoutMs: t.timeoutMs,
        tokenEstimate: t.tokenEstimate,
      }));
    await writeFile(filePath, JSON.stringify(toSave, null, 2), "utf-8");
    // Restrict to owner-only — prompts may contain sensitive code or secrets
    await fs.promises.chmod(filePath, 0o600);
  }

  /** Load persisted tasks from disk on startup. Best-effort. */
  async loadPersistedTasks(port: number): Promise<void> {
    const filePath = join(homedir(), ".claude", "ide", `tasks-${port}.json`);
    try {
      const raw = await readFile(filePath, "utf-8");
      // biome-ignore lint/suspicious/noExplicitAny: raw JSON from disk — validated field-by-field below
      const saved = JSON.parse(raw) as any[];
      if (!Array.isArray(saved)) return;
      for (const t of saved) {
        if (typeof t.id !== "string") continue;
        // Only load terminal tasks; do not resurrect in-progress ones
        if (
          t.status !== "done" &&
          t.status !== "error" &&
          t.status !== "cancelled"
        )
          continue;
        if (!this.tasks.has(t.id)) {
          const prompt: string = typeof t.prompt === "string" ? t.prompt : "";
          // Only restore context files that are workspace-confined regular files
          const normalizedWorkspace = resolvePath(this.workspace);
          const contextFiles: string[] = Array.isArray(t.contextFiles)
            ? t.contextFiles.filter((f: unknown) => {
                if (typeof f !== "string") return false;
                const abs = resolvePath(f);
                if (
                  abs !== normalizedWorkspace &&
                  !abs.startsWith(`${normalizedWorkspace}/`)
                )
                  return false;
                try {
                  return fs.lstatSync(abs).isFile();
                } catch {
                  return false;
                }
              })
            : [];
          const task: ClaudeTask = {
            id: t.id,
            sessionId: typeof t.sessionId === "string" ? t.sessionId : "",
            prompt,
            contextFiles,
            status: t.status as TaskStatus,
            createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
            startedAt:
              typeof t.startedAt === "number" ? t.startedAt : undefined,
            doneAt: typeof t.doneAt === "number" ? t.doneAt : undefined,
            output: typeof t.output === "string" ? t.output : undefined,
            errorMessage:
              typeof t.errorMessage === "string" ? t.errorMessage : undefined,
            timeoutMs:
              typeof t.timeoutMs === "number"
                ? t.timeoutMs
                : ClaudeOrchestrator.DEFAULT_TIMEOUT_MS,
            tokenEstimate:
              typeof t.tokenEstimate === "number"
                ? t.tokenEstimate
                : estimateTokens(prompt),
          };
          this.tasks.set(task.id, task);
        }
      }
    } catch {
      // File may not exist on first run — silently ignore
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
