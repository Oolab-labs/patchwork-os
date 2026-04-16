/**
 * InterpreterContext — backend interface + concrete implementations for the
 * AutomationProgram interpreter.
 */
import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { AutomationState } from "./automationState.js";

// ── Backend interface ─────────────────────────────────────────────────────────

export interface BackendEnqueueOpts {
  prompt: string;
  triggerSource: string;
  sessionId: string;
  isAutomationTask: true;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  systemPrompt?: string;
}

export interface Backend {
  /** Enqueue a task and return the task ID. */
  enqueueTask(opts: BackendEnqueueOpts): Promise<string>;
  /** Schedule a retry after delayMs; returns a cancel function. */
  scheduleRetry(key: string, delayMs: number, fn: () => void): () => void;
  /** Emit an informational notification (fire-and-forget). */
  notify(msg: string): void;
}

// ── Interpreter context ───────────────────────────────────────────────────────

export interface InterpreterContext {
  readonly state: AutomationState;
  readonly now: number;
  readonly eventData: Readonly<Record<string, string>>;
  readonly backend: Backend;
  readonly log: (msg: string) => void;
}

// ── Interpreter result ────────────────────────────────────────────────────────

export interface InterpreterResult {
  readonly taskIds: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ reason: string; hook: string }>;
  readonly errors: ReadonlyArray<{ message: string; hook: string }>;
  readonly updatedState: AutomationState;
}

// ── VsCodeBackend ─────────────────────────────────────────────────────────────

export class VsCodeBackend implements Backend {
  constructor(
    private readonly orchestrator: ClaudeOrchestrator,
    private readonly logger?: { info: (msg: string) => void },
  ) {}

  async enqueueTask(opts: BackendEnqueueOpts): Promise<string> {
    const taskId = this.orchestrator.enqueue({
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      isAutomationTask: opts.isAutomationTask,
      triggerSource: opts.triggerSource,
      model: opts.model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
    });
    return taskId;
  }

  scheduleRetry(key: string, delayMs: number, fn: () => void): () => void {
    const handle = setTimeout(() => {
      this.logger?.info(`[automation] retrying ${key}`);
      fn();
    }, delayMs);
    return () => clearTimeout(handle);
  }

  notify(msg: string): void {
    this.logger?.info(msg);
  }
}

// ── TestBackend ───────────────────────────────────────────────────────────────

export interface TestBackendCollector {
  enqueuedTasks: BackendEnqueueOpts[];
  scheduledRetries: Array<{ key: string; delayMs: number }>;
  notifications: string[];
}

export class TestBackend implements Backend {
  readonly collector: TestBackendCollector = {
    enqueuedTasks: [],
    scheduledRetries: [],
    notifications: [],
  };

  async enqueueTask(opts: BackendEnqueueOpts): Promise<string> {
    this.collector.enqueuedTasks.push(opts);
    return `task-${this.collector.enqueuedTasks.length}`;
  }

  scheduleRetry(key: string, delayMs: number, _fn: () => void): () => void {
    this.collector.scheduledRetries.push({ key, delayMs });
    // Do not actually schedule in test environment
    return () => {};
  }

  notify(msg: string): void {
    this.collector.notifications.push(msg);
  }

  reset(): void {
    this.collector.enqueuedTasks = [];
    this.collector.scheduledRetries = [];
    this.collector.notifications = [];
  }
}
