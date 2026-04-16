import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

function getConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

import type { IClaudeDriver } from "./claudeDriver.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export type CancelReason = "timeout" | "startup_timeout" | "user" | "shutdown";

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
  /** Effort level for the task (low/medium/high/max). */
  effort?: "low" | "medium" | "high" | "max";
  /** Fallback model when the primary is overloaded. */
  fallbackModel?: string;
  /** Maximum spend cap in USD for this task. */
  maxBudgetUsd?: number;
  /** Abort the task if no assistant output arrives within this many ms of spawn. */
  startupTimeoutMs?: number;
  /** True when this task was spawned by an automation hook. */
  isAutomationTask?: boolean;
  /** Hook name that triggered this task (e.g. "onFileSave", "onDiagnosticsError"). */
  triggerSource?: string;
  /** Custom system prompt passed via --system-prompt to the subprocess. */
  systemPrompt?: string;
  /** If true, this task was dispatched to the ant binary instead of claude. */
  useAnt?: boolean;
  /** Set when status === "cancelled": what triggered the cancel. */
  cancelReason?: CancelReason;
  /** Last ~2KB of subprocess stderr — populated on timeout and other aborts. */
  stderrTail?: string;
  /** True when the subprocess was aborted (signal). */
  wasAborted?: boolean;
  /** Milliseconds from spawn to first assistant output. Undefined if no output arrived before timeout. */
  startupMs?: number;
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
  /** Effort level for the task (low/medium/high/max). */
  effort?: "low" | "medium" | "high" | "max";
  /** Fallback model when the primary is overloaded. */
  fallbackModel?: string;
  /** Maximum spend cap in USD for this task. */
  maxBudgetUsd?: number;
  /** Abort the task if no assistant output arrives within this many ms of spawn. */
  startupTimeoutMs?: number;
  /** Custom system prompt passed via --system-prompt to the subprocess. */
  systemPrompt?: string;
  /** Original creation timestamp — used when re-enqueuing persisted tasks. */
  createdAt?: number;
  /** True when this task was spawned by an automation hook (prevents infinite chain in onTaskSuccess). */
  isAutomationTask?: boolean;
  /** Hook name that created this task (e.g. "onFileSave", "onDiagnosticsError"). Logged at task start for observability. */
  triggerSource?: string;
  /** If true, spawn ant binary instead of claude. */
  useAnt?: boolean;
};

/** Shape of a task entry in the v1 tasks file. */
interface PersistedTask {
  id: string;
  sessionId: string;
  prompt: string;
  contextFiles: string[];
  status: string;
  output?: string;
  errorMessage?: string;
  createdAt: number;
  startedAt?: number;
  doneAt?: number;
  timeoutMs: number;
  tokenEstimate: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  fallbackModel?: string;
  maxBudgetUsd?: number;
  startupTimeoutMs?: number;
  cancelReason?: CancelReason;
  stderrTail?: string;
  wasAborted?: boolean;
  startupMs?: number;
  triggerSource?: string;
  systemPrompt?: string;
}

export class ClaudeOrchestrator {
  static readonly MAX_CONCURRENT = 10;
  static readonly MAX_QUEUE = 20;
  static readonly MAX_HISTORY = 500;
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
  /** Cancel-reason map populated by `cancel()` before aborting the controller. */
  private cancelReasons = new Map<string, Exclude<CancelReason, "timeout">>();
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
      createdAt: opts.createdAt ?? Date.now(),
      timeoutMs: opts.timeoutMs ?? ClaudeOrchestrator.DEFAULT_TIMEOUT_MS,
      tokenEstimate: estimateTokens(opts.prompt),
      ...(opts.model !== undefined && { model: opts.model }),
      ...(opts.effort !== undefined && { effort: opts.effort }),
      ...(opts.fallbackModel !== undefined && {
        fallbackModel: opts.fallbackModel,
      }),
      ...(opts.maxBudgetUsd !== undefined && {
        maxBudgetUsd: opts.maxBudgetUsd,
      }),
      ...(opts.startupTimeoutMs !== undefined && {
        startupTimeoutMs: opts.startupTimeoutMs,
      }),
      ...(opts.isAutomationTask !== undefined && {
        isAutomationTask: opts.isAutomationTask,
      }),
      ...(opts.triggerSource !== undefined && {
        triggerSource: opts.triggerSource,
      }),
      ...(opts.systemPrompt !== undefined && {
        systemPrompt: opts.systemPrompt,
      }),
      ...(opts.useAnt !== undefined && { useAnt: opts.useAnt }),
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
    const res = this.findTaskByPrefix(id);
    return res.ambiguous ? undefined : res.task;
  }

  /**
   * Resolve a task ID, with support for UUID prefixes (≥8 chars).
   * Returns `{task}` on unique exact/prefix match, `{ambiguous: true, candidates}` when
   * multiple prefix matches exist (caller should surface as error), or `{}` for no match.
   *
   * Optional `visible(task)` predicate scopes both the match AND the candidate list
   * to tasks the caller is allowed to see — prevents cross-session prefix enumeration.
   * When omitted, all tasks are visible (internal callers only).
   */
  findTaskByPrefix(
    id: string,
    visible?: (task: ClaudeTask) => boolean,
  ): {
    task?: ClaudeTask;
    ambiguous?: boolean;
    candidates?: string[];
  } {
    const canSee = (t: ClaudeTask) => (visible ? visible(t) : true);
    const exact = this.tasks.get(id);
    if (exact && canSee(exact)) return { task: exact };
    if (id.length >= 8 && id.length < 36) {
      const matches: ClaudeTask[] = [];
      for (const [key, task] of this.tasks) {
        if (key.startsWith(id) && canSee(task)) {
          matches.push(task);
          if (matches.length > 1) break;
        }
      }
      if (matches.length === 1) return { task: matches[0] };
      if (matches.length > 1) {
        const candidates: string[] = [];
        for (const [key, task] of this.tasks) {
          if (key.startsWith(id) && canSee(task)) {
            candidates.push(key);
            if (candidates.length >= 10) break;
          }
        }
        return { ambiguous: true, candidates };
      }
    }
    return {};
  }

  list(status?: TaskStatus): ClaudeTask[] {
    const all = [...this.tasks.values()];
    if (status === undefined) return all;
    return all.filter((t) => t.status === status);
  }

  /**
   * Cancel a pending or running task.
   * @param reason "user" (default) for explicit user cancellation, "shutdown"
   * for bridge shutdown. Timeouts are detected internally in `_runTask` and
   * do not flow through this method.
   * Returns true if the task was found and cancellation was initiated.
   */
  cancel(
    id: string,
    reason: Exclude<CancelReason, "timeout"> = "user",
  ): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "pending") {
      task.status = "cancelled";
      task.cancelReason = reason;
      task.doneAt = Date.now();
      task.output = ""; // never ran — ensure output field always exists
      this.queue = this.queue.filter((qid) => qid !== id);
      this._fireCompletion(id);
      this.log(
        `[orchestrator] cancelled pending task ${id.slice(0, 8)} (reason=${reason})`,
      );
      return true;
    }
    if (task.status === "running") {
      // Record the reason *before* abort so _runTask can read it in its handler.
      this.cancelReasons.set(id, reason);
      this.controllers.get(id)?.abort();
      this.log(
        `[orchestrator] aborting running task ${id.slice(0, 8)} (reason=${reason})`,
      );
      return true;
    }
    return false;
  }

  private _drain(): void {
    // Guard against infinite loop: if we cycle through the entire queue without
    // starting any task (all tasks exceed token budget), stop rather than spinning.
    let skipped = 0;
    while (
      this.running.size < ClaudeOrchestrator.MAX_CONCURRENT &&
      this.queue.length > 0
    ) {
      const id = this.queue[0];
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.status !== "pending") {
        this.queue.shift();
        skipped = 0; // stale entry removed — reset cycle counter
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
        skipped++;
        // Full cycle with no starts — all remaining tasks exceed budget; stop draining.
        if (skipped >= this.queue.length) break;
        continue;
      }
      this.queue.shift();
      skipped = 0;
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
      `[orchestrator] starting task ${id.slice(0, 8)} (~${task.tokenEstimate} tokens, ${this._activeTokens} in-flight)${task.triggerSource ? ` [${task.triggerSource}]` : ""}`,
    );

    // Set up timeout. timedOut flag distinguishes timer-driven aborts from
    // user/shutdown cancels (which populate this.cancelReasons via cancel()).
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
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
        effort: task.effort,
        fallbackModel: task.fallbackModel,
        maxBudgetUsd: task.maxBudgetUsd,
        startupTimeoutMs: task.startupTimeoutMs,
        systemPrompt: task.systemPrompt,
        useAnt: task.useAnt,
        onChunk: (chunk: string) => {
          // Per-task streaming callback (e.g. for MCP notifications/progress)
          this.taskCallbacks.get(id)?.(chunk);
          // Global chunk notification (for VS Code output channel)
          this.notifyChunk?.(id, chunk);
        },
      });

      // v2.24.1: SubprocessDriver no longer throws on abort — it returns
      // { wasAborted: true } so stderrTail and partial output can be surfaced.
      task.startupMs = result.startupMs;
      if (result.wasAborted) {
        task.status = "cancelled";
        task.wasAborted = true;
        task.stderrTail = result.stderrTail;
        task.cancelReason = result.startupTimedOut
          ? "startup_timeout"
          : timedOut
            ? "timeout"
            : (this.cancelReasons.get(id) ?? "user");
        // Always set output (even empty) so analytics report includes the field.
        task.output = result.text;
      } else {
        task.output = result.text;
        task.stderrTail = result.stderrTail;
        task.status = result.exitCode === 0 ? "done" : "error";
        if (result.exitCode !== 0) {
          task.errorMessage = `Process exited with code ${result.exitCode}`;
        }
      }
    } catch (err) {
      // Non-abort errors (spawn failure, driver bug, etc.)
      if (
        (err instanceof Error && err.name === "AbortError") ||
        controller.signal.aborted
      ) {
        // Fallback for drivers that still throw on abort.
        task.status = "cancelled";
        task.wasAborted = true;
        task.cancelReason = timedOut
          ? "timeout"
          : (this.cancelReasons.get(id) ?? "user");
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
      this.cancelReasons.delete(id);
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

  /** Build the serialisable task list for disk persistence.
   * running tasks are saved as "interrupted" so on reload they appear as a
   * known-terminal state rather than a stale "running" entry. */
  private _buildTasksPayload(): PersistedTask[] {
    return [...this.tasks.values()].map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      prompt: t.prompt,
      contextFiles: t.contextFiles,
      status: (t.status === "running" ? "interrupted" : t.status) as string,
      output: t.output,
      errorMessage: t.errorMessage,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      doneAt: t.doneAt,
      timeoutMs: t.timeoutMs,
      tokenEstimate: t.tokenEstimate,
      ...(t.model !== undefined && { model: t.model }),
      ...(t.effort !== undefined && { effort: t.effort }),
      ...(t.fallbackModel !== undefined && { fallbackModel: t.fallbackModel }),
      ...(t.maxBudgetUsd !== undefined && { maxBudgetUsd: t.maxBudgetUsd }),
      ...(t.startupTimeoutMs !== undefined && {
        startupTimeoutMs: t.startupTimeoutMs,
      }),
      ...(t.cancelReason !== undefined && { cancelReason: t.cancelReason }),
      ...(t.stderrTail !== undefined && { stderrTail: t.stderrTail }),
      ...(t.wasAborted !== undefined && { wasAborted: t.wasAborted }),
      ...(t.startupMs !== undefined && { startupMs: t.startupMs }),
      ...(t.systemPrompt !== undefined && { systemPrompt: t.systemPrompt }),
      ...(t.triggerSource !== undefined && { triggerSource: t.triggerSource }),
    }));
  }

  /** Persist all tasks to disk for cross-session resumability. Best-effort. */
  async persistTasks(port: number): Promise<void> {
    const filePath = join(getConfigDir(), "ide", `tasks-${port}.json`);
    const payload = {
      version: 1,
      savedAt: Date.now(),
      tasks: this._buildTasksPayload(),
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    // Restrict to owner-only — prompts may contain sensitive code or secrets
    await fs.promises.chmod(filePath, 0o600);
  }

  /** Synchronous flush called during shutdown — captures tasks at their true
   * pre-cancellation state (pending = still pending, running = interrupted).
   * Must be called BEFORE cancel() so the status snapshot is accurate. */
  flushTasksToDisk(port: number): void {
    const filePath = join(getConfigDir(), "ide", `tasks-${port}.json`);
    try {
      const payload = {
        version: 1,
        savedAt: Date.now(),
        tasks: this._buildTasksPayload(),
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
  }

  /** Load persisted tasks from disk on startup. Best-effort.
   *
   * File format:
   * - v0 (array at root): terminal tasks only — loaded as history, no re-enqueue
   * - v1 ({version:1, tasks:[]}): pending tasks are re-enqueued; interrupted/terminal
   *   tasks are restored as history; unknown future versions fall back to terminal-only
   */
  async loadPersistedTasks(port: number): Promise<void> {
    const filePath = join(getConfigDir(), "ide", `tasks-${port}.json`);
    try {
      const raw = await readFile(filePath, "utf-8");
      // biome-ignore lint/suspicious/noExplicitAny: raw JSON from disk — validated field-by-field below
      const parsed = JSON.parse(raw) as any;

      let saved: PersistedTask[];
      let reenqueuePending = false;

      if (Array.isArray(parsed)) {
        // v0: raw array — terminal tasks only (existing behaviour)
        saved = parsed as PersistedTask[];
        reenqueuePending = false;
      } else if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof parsed.version === "number"
      ) {
        const tasks = Array.isArray(parsed.tasks)
          ? (parsed.tasks as PersistedTask[])
          : [];
        if (parsed.version === 1) {
          saved = tasks;
          reenqueuePending = true;
        } else {
          // Unknown future version — conservative fallback: terminal tasks only
          this.log(
            `[orchestrator] tasks file version ${parsed.version} unknown — restoring terminal tasks only`,
          );
          saved = tasks.filter(
            (t) =>
              t.status === "done" ||
              t.status === "error" ||
              t.status === "cancelled" ||
              t.status === "interrupted",
          );
          reenqueuePending = false;
        }
      } else {
        return;
      }

      const normalizedWorkspace = resolvePath(this.workspace);
      let reenqueued = 0;
      let overflow = 0;

      for (const t of saved) {
        if (typeof t.id !== "string") continue;
        if (this.tasks.has(t.id)) continue;

        const prompt: string = typeof t.prompt === "string" ? t.prompt : "";
        // Only restore context files that are workspace-confined regular files
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

        if (reenqueuePending && t.status === "pending") {
          if (
            this.queue.length + this.running.size <
            ClaudeOrchestrator.MAX_QUEUE
          ) {
            // Re-enqueue with original ID and creation timestamp
            this._enqueueWithId(t.id, {
              prompt,
              contextFiles,
              timeoutMs:
                typeof t.timeoutMs === "number"
                  ? t.timeoutMs
                  : ClaudeOrchestrator.DEFAULT_TIMEOUT_MS,
              sessionId: typeof t.sessionId === "string" ? t.sessionId : "",
              createdAt:
                typeof t.createdAt === "number" ? t.createdAt : undefined,
              ...(t.model !== undefined && { model: t.model }),
              ...(t.effort !== undefined && { effort: t.effort }),
              ...(t.fallbackModel !== undefined && {
                fallbackModel: t.fallbackModel,
              }),
              ...(t.maxBudgetUsd !== undefined && {
                maxBudgetUsd: t.maxBudgetUsd,
              }),
              ...(t.startupTimeoutMs !== undefined && {
                startupTimeoutMs: t.startupTimeoutMs,
              }),
              ...(t.systemPrompt !== undefined && {
                systemPrompt: t.systemPrompt,
              }),
            });
            reenqueued++;
          } else {
            // Queue full — demote to interrupted history
            this._restoreTerminalTask(t, prompt, contextFiles, "interrupted");
            overflow++;
          }
          continue;
        }

        // Terminal statuses (done/error/cancelled/interrupted) — restore as history
        if (
          t.status === "done" ||
          t.status === "error" ||
          t.status === "cancelled" ||
          t.status === "interrupted"
        ) {
          this._restoreTerminalTask(
            t,
            prompt,
            contextFiles,
            t.status as TaskStatus,
          );
        }
        // "running" entries in the file should have been saved as "interrupted" by
        // flushTasksToDisk — skip any that somehow slipped through.
      }

      if (reenqueued > 0 || overflow > 0) {
        const parts: string[] = [];
        if (reenqueued > 0) parts.push(`${reenqueued} task(s) re-enqueued`);
        if (overflow > 0)
          parts.push(`${overflow} task(s) demoted to interrupted (queue full)`);
        this.log(
          `[orchestrator] restored from previous run: ${parts.join(", ")}`,
        );
      }
    } catch {
      // File may not exist on first run — silently ignore
    }
  }

  private _restoreTerminalTask(
    t: PersistedTask,
    prompt: string,
    contextFiles: string[],
    status: TaskStatus,
  ): void {
    const task: ClaudeTask = {
      id: t.id,
      sessionId: typeof t.sessionId === "string" ? t.sessionId : "",
      prompt,
      contextFiles,
      status,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
      startedAt: typeof t.startedAt === "number" ? t.startedAt : undefined,
      doneAt: typeof t.doneAt === "number" ? t.doneAt : Date.now(),
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
      ...(t.model !== undefined && { model: t.model }),
      ...(t.effort !== undefined && { effort: t.effort }),
      ...(t.fallbackModel !== undefined && { fallbackModel: t.fallbackModel }),
      ...(t.maxBudgetUsd !== undefined && { maxBudgetUsd: t.maxBudgetUsd }),
      ...(t.startupTimeoutMs !== undefined && {
        startupTimeoutMs: t.startupTimeoutMs,
      }),
      ...(typeof t.startupMs === "number" && { startupMs: t.startupMs }),
      ...(t.systemPrompt !== undefined && { systemPrompt: t.systemPrompt }),
    };
    this.tasks.set(task.id, task);
  }

  private _pruneHistory(): void {
    if (this.tasks.size <= ClaudeOrchestrator.MAX_HISTORY) return;
    // Remove oldest terminal tasks until we're at MAX_HISTORY
    const terminal = [...this.tasks.values()]
      .filter(
        (t) =>
          t.status === "done" ||
          t.status === "error" ||
          t.status === "cancelled" ||
          t.status === "interrupted",
      )
      .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));

    const toRemove = this.tasks.size - ClaudeOrchestrator.MAX_HISTORY;
    for (let i = 0; i < toRemove && i < terminal.length; i++) {
      const entry = terminal[i];
      if (entry) this.tasks.delete(entry.id);
    }
  }
}
