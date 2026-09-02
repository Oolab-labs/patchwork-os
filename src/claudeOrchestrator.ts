import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  isAbsolute as isAbsolutePath,
  join,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";

function getConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

import {
  decryptSecretString,
  encryptSecretString,
} from "./connectors/tokenStorage.js";
import type { IClaudeDriver } from "./drivers/types.js";
import {
  killSwitchMessage,
  readKillSwitch,
} from "./governance/killSwitchPolicy.js";
import { redactKnownSecrets } from "./governance/secretValues.js";
import { loadConfig as loadPatchworkConfig } from "./patchworkConfig.js";
import { sharedBoundaryReceiptLog } from "./privacy/boundaryReceiptLog.js";
import {
  CLASSIFICATIONS,
  type Classification,
  DEFAULT_CLASSIFICATION,
  decideBoundary,
} from "./privacy/dataPolicy.js";
import {
  type PrivacyConfig,
  parseRegistry,
  resolveDestination,
} from "./privacy/destinationRegistry.js";
import { recordPrivacyShadow } from "./privacy/shadowLog.js";
import { resolveWorkspaceRoot } from "./recipes/workspaceRoot.js";
import { currentWorkspaceId } from "./workspaceId.js";
import { writeFileAtomic, writeFileAtomicSync } from "./writeFileAtomic.js";

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
  /**
   * If true, the spawned `claude -p` is given a temp `--mcp-config` pointing at
   * the bridge's HTTP MCP endpoint so it can call bridge tools. Opt-in per
   * task; default off because most subprocesses shouldn't recurse into the
   * bridge that spawned them.
   */
  mcpAccess?: boolean;
  /** P0-5 opt-in tool sandbox — repackaged into providerOptions at the driver.run hop. */
  sandbox?: boolean;
  /** Tool allowlist enforced via --allowed-tools when sandbox is true. */
  allowedTools?: string[];
  /** Deny rules via --disallowed-tools (any mode). */
  disallowedTools?: string[];
  /** Resolved governed containment (Phase 0 step 6); forwarded to the driver. */
  containment?: import("./governance/profile.js").AgentContainment;
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
  /**
   * If true, inject bridge MCP into the spawned `claude -p` so the agent can
   * call bridge tools. Opt-in per task — see ClaudeTask.mcpAccess for details.
   */
  mcpAccess?: boolean;
  /**
   * P0-5 opt-in tool sandbox. When `sandbox` is true and `allowedTools` is
   * non-empty, the spawned `claude -p` runs with --permission-mode dontAsk +
   * --allowed-tools and DROPS --dangerously-skip-permissions. `disallowedTools`
   * applies in any mode. Repackaged into providerOptions at the driver.run hop.
   */
  sandbox?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  containment?: import("./governance/profile.js").AgentContainment;
};

/** Encrypt a prompt for the tasks file; undefined when the key layer is unavailable. */
function encryptPromptForPersistence(prompt: string): string | undefined {
  try {
    return encryptSecretString(prompt);
  } catch {
    return undefined;
  }
}

/**
 * Recover a persisted task's prompt. `recovered` is true only when the FULL
 * prompt is available — decrypted, or a legacy clear-text row. A preview is
 * enough to show history, never enough to run.
 */
function restorePrompt(t: PersistedTask): {
  prompt: string;
  recovered: boolean;
} {
  if (typeof t.promptEncrypted === "string") {
    let plain: string | null = null;
    try {
      plain = decryptSecretString(t.promptEncrypted);
    } catch {
      plain = null;
    }
    if (plain !== null) return { prompt: plain, recovered: true };
  }
  if (typeof t.prompt === "string")
    return { prompt: t.prompt, recovered: true };
  return {
    prompt: typeof t.promptPreview === "string" ? t.promptPreview : "",
    recovered: false,
  };
}

/** Shape of a task entry in the v1 tasks file. */
interface PersistedTask {
  id: string;
  sessionId: string;
  /**
   * LEGACY (files written before secret handling): the prompt in clear text.
   * Read on restore, never written. New files carry the three fields below.
   */
  prompt?: string;
  /** sha256 of the full prompt — lets a reader match a task to a prompt it holds. */
  promptSha256?: string;
  /** First 200 chars of the prompt AFTER value-based redaction. Display only. */
  promptPreview?: string;
  /**
   * The full prompt, AES-256-GCM under the connector-token master key
   * (`encryptSecretString`). Present when the key layer is available; a
   * pending task whose prompt cannot be recovered on restore is demoted to
   * `interrupted` rather than re-run against a truncated preview.
   */
  promptEncrypted?: string;
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
  // Audit 2026-06-03 (HIGH #11): these must survive a persist→restart→reload
  // round-trip. Dropping them silently re-ran tasks with the wrong binary
  // (useAnt), without bridge tool access (mcpAccess), or without the
  // automation infinite-chain guard (isAutomationTask).
  useAnt?: boolean;
  mcpAccess?: boolean;
  // P0-5: a sandboxed task must STAY sandboxed after a bridge restart →
  // persist + reload these alongside mcpAccess (audit HIGH #11 durability).
  sandbox?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  containment?: import("./governance/profile.js").AgentContainment;
  isAutomationTask?: boolean;
}

/**
 * Privacy SHADOW observation for orchestrator dispatch (#1397, ADR-0021).
 *
 * This path is UNGOVERNED and stays ungoverned: nothing here enforces, refuses,
 * or alters a dispatch. It records what a candidate policy WOULD have said, so
 * the question "should this path be governed, and how?" stops being answered
 * from zero measurements.
 *
 * Why observation is allowed where enforcement is not. ADR-0021 leaves this
 * path out of scope because an orchestrator task has no declared `data_policy`
 * and no natural place to put one — so enforcing would mean giving every task
 * the `internal` default and writing an affirmative receipt about a label
 * nobody supplied. That objection is about ASSERTING A DECLARATION, not about
 * looking: every row written here is stamped `labelSource: "assumed"`, and the
 * report renders assumed rows separately rather than as operator intent.
 *
 * Deliberately NOT injected as a constructor dep. Optional deps that no caller
 * supplies are indistinguishable at runtime from a feature that was never
 * built — the exact state ADR-0021 records for the boundary before
 * `buildAgentExecutorDeps` wired it. Reading its own config means there is no
 * wiring to forget. It stays inert unless `privacy.shadow` is configured.
 */
function observeOrchestratorShadow(
  driverName: string | undefined,
  workspace: string | undefined,
  /**
   * The operator's PATH-LEVEL classification, if they have opted this path into
   * enforcement. Passed in rather than re-read so the shadow row and the
   * receipt describe the SAME dispatch with the same label — the two ledgers
   * disagreeing about where a classification came from is the failure this
   * field exists to prevent.
   */
  pathClassification: Classification | undefined,
): void {
  try {
    const cfg = (
      loadPatchworkConfig() as { privacy?: { shadow?: PrivacyConfig } }
    ).privacy?.shadow;
    if (!cfg) return;
    // Once an operator has classified this channel, the candidate policy must
    // be evaluated against THAT label. Continuing to shadow against the
    // runtime's `internal` fallback would answer a question nobody is asking
    // any more, and would answer it more permissively than the live policy.
    const classification = pathClassification ?? DEFAULT_CLASSIFICATION;
    const registry = parseRegistry(cfg);
    const resolved = resolveDestination(
      registry,
      driverName,
      classification,
      {},
    );
    if (!resolved) return;
    const outcome = decideBoundary({ classification }, resolved.destination, {
      // Forwarded, NOT dropped. `resolveDestination` computes this and the
      // recipe path passes it on; omitting it here made the same policy give
      // two answers for one situation — see the enforcement site below.
      localDestinationAccepts: resolved.localDestinationAccepts,
    });
    recordPrivacyShadow({
      ...(currentWorkspaceId(workspace) && {
        workspaceId: currentWorkspaceId(workspace),
      }),
      decision: outcome.decision,
      reason: outcome.reason,
      destinationId: resolved.destination.id,
      destinationType: resolved.destination.type,
      classification,
      path: "orchestrator-task",
      // NO `correlationId`, deliberately, and registered as such in
      // `SHADOW_RECORD_VERSION`'s field registry. An orchestrator task is not a
      // recipe run and has no row in `runs.jsonl`, so there is no run id to
      // give — and stamping this with the orchestrator's own task id would put
      // two different kinds of identity under one field name, which is the
      // thing the `rv` protocol exists to prevent. Absence here is a STATE. Do
      // not "complete" the coverage by filling it.
      // `default` when the operator classified the CHANNEL, `assumed` when
      // nobody said anything and the runtime fell back. Never `declared`: no
      // operator ever saw this prompt, which is the claim ADR-0021 refuses to
      // make and the reason `default` is a third value rather than a synonym.
      labelSource: pathClassification ? "default" : "assumed",
      // TRUE once the path is governed. Leaving this hardcoded false would tell
      // `patchwork privacy shadow` that a live policy was not enforcing while
      // it was — turning a counterfactual report into a false one on exactly
      // the rows an operator would check after switching enforcement on.
      enforcing: pathClassification !== undefined,
    });
  } catch {
    // Observation must never disturb the dispatch it observes.
  }
}

/**
 * The class of failure a refused dispatch reports.
 *
 * A distinct Error subclass rather than a bare `throw new Error`: `_runTask`'s
 * catch already distinguishes aborts from everything else, and a refusal is
 * neither a crashed driver nor a cancellation. Naming it means a reader of the
 * task list can tell "the boundary stopped this" from "the driver died", which
 * is the entire operator-facing value of enforcing at all.
 */
export class InformationBoundaryRefusal extends Error {
  constructor(reason: string) {
    super(`information boundary — ${reason}`);
    this.name = "InformationBoundaryRefusal";
  }
}

/**
 * Read the operator's PATH-LEVEL classification for orchestrator dispatch.
 *
 * Presence of `privacy.orchestrator.classification` is the opt-in to
 * ENFORCEMENT on this path, and its absence leaves the path exactly as it was:
 * observed in shadow, never refused. That is deliberate and is the same
 * inert-until-opted-in posture ADR-0021 requires of the recipe path — no
 * existing install changes behaviour by upgrading.
 *
 * An unparseable or unknown value returns undefined, i.e. NOT ENFORCING. That
 * direction is chosen against the usual fail-closed instinct because the
 * failure here is a typo in an optional key: failing closed would refuse every
 * orchestrator task on the machine — including the automation hooks an operator
 * relies on — on the strength of a misspelling. `patchwork privacy
 * destinations` reports the misconfiguration; a dead bridge does not.
 */
function orchestratorPathClassification(
  cfg: { orchestrator?: { classification?: unknown } } | undefined,
): Classification | undefined {
  const raw = cfg?.orchestrator?.classification;
  if (typeof raw !== "string") return undefined;
  return (CLASSIFICATIONS as readonly string[]).includes(raw)
    ? (raw as Classification)
    : undefined;
}

/**
 * ENFORCE the information boundary on orchestrator dispatch (ADR-0021
 * 2026-08-30 amendment, closing the gap #1397 recorded).
 *
 * ADR-0021 left this path ungoverned for one stated reason, and it was never
 * "the wiring is hard": enforcing with the runtime's own `internal` default
 * would write an affirmative receipt about a label nobody supplied. The ADR
 * named the precondition — "a per-task label, or a workspace-level default that
 * is recorded honestly as a default rather than as a declaration" — and left
 * the choice between them to be made from measured volume rather than taste.
 *
 * The volume chose it. Over 11 days the shadow ledger recorded 10 orchestrator
 * dispatches against 288 recipe agent steps. On a path carrying ~3% of traffic,
 * an optional per-task label is a field nobody fills, and a declaration channel
 * that is mostly empty manufactures `assumed` rows wearing a `declared` shape —
 * worse than no channel, because it looks like coverage.
 *
 * So: a workspace-level default, stamped `labelSource: "default"` — a third
 * value, never folded into either existing one. It says exactly what is true:
 * an operator classified this CHANNEL, not this prompt.
 *
 * Returns normally when the dispatch may proceed, including when nothing is
 * configured. THROWS to refuse. It must never be made fail-soft like the shadow
 * observation beside it: an enforcement that swallows its own errors is an
 * enforcement that silently stops enforcing.
 */
function governOrchestratorDispatch(
  driverName: string | undefined,
  workspace: string | undefined,
  classification: Classification | undefined,
): void {
  // Not opted in. The path stays observed-but-ungoverned, as it has been
  // since #1397.
  if (classification === undefined) return;
  const cfg = (loadPatchworkConfig() as { privacy?: PrivacyConfig }).privacy;
  const registry = parseRegistry(cfg);
  const resolved = resolveDestination(registry, driverName, classification, {});
  // No destination registered for this driver and classification. The registry
  // is the opt-in for the boundary as a whole (ADR-0021), so an unregistered
  // destination is inert here exactly as it is on the recipe path — NOT a
  // refusal, which would make configuring the orchestrator key alone break
  // every dispatch.
  if (!resolved) return;
  // `localDestinationAccepts` is FORWARDED, and the omission it replaces was a
  // real defect caught by running the deployed build rather than by reading it.
  //
  // `decideBoundary` rule 1 offers LOCAL_ONLY — "a local destination accepts
  // it" — only when told that one does. `resolveDestination` computes exactly
  // that and hands it back; the recipe path forwards it. Dropping it here made
  // the orchestrator answer DENY ("no approval can unlock it") for a dispatch
  // the recipe path calls LOCAL_ONLY ("set `driver: local`").
  //
  // The direction was safe — DENY is stricter — which is precisely why it would
  // have survived review: nothing leaks, no test for the refusal itself fails.
  // What was wrong is the SENTENCE an operator reads. It states their situation
  // is unfixable while a registered local destination would accept the data, so
  // the one remedy available is the one the message rules out.
  //
  // Two notions of one policy is the failure this whole subsystem is built to
  // avoid, and it appeared inside the change that was meant to close it.
  const outcome = decideBoundary({ classification }, resolved.destination, {
    localDestinationAccepts: resolved.localDestinationAccepts,
  });
  const wsId = currentWorkspaceId(workspace);
  try {
    sharedBoundaryReceiptLog().record({
      ...(wsId && { workspaceId: wsId }),
      decision: outcome.decision,
      classification,
      destinationId: resolved.destination.id,
      destinationType: resolved.destination.type,
      reason: outcome.reason,
      // The precondition ADR-0021 names, in the ledger that says what actually
      // happened. Never "declared": no operator saw this prompt.
      labelSource: "default",
      // No `categories`: a path-level default classifies the CHANNEL, and
      // category names come from a per-dispatch `data_policy` that this path
      // by definition does not have. Emitting an empty list would suggest the
      // categories were examined and found to be none.
      ...(outcome.redactCategories && {
        redactCategories: outcome.redactCategories,
      }),
    });
  } catch {
    // A receipt that cannot be written must not change the decision it
    // describes. This swallow covers the RECORD only — the refusal below is
    // outside it, so a broken disk cannot quietly reopen the boundary.
  }
  if (outcome.decision !== "ALLOW") {
    throw new InformationBoundaryRefusal(outcome.reason);
  }
}

export class ClaudeOrchestrator {
  static readonly MAX_CONCURRENT = 10;
  static readonly MAX_QUEUE = 20;
  static readonly MAX_HISTORY = 500;
  static readonly DEFAULT_TIMEOUT_MS = 600_000;
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
      ...(opts.mcpAccess !== undefined && { mcpAccess: opts.mcpAccess }),
      ...(opts.sandbox !== undefined && { sandbox: opts.sandbox }),
      ...(opts.allowedTools !== undefined && {
        allowedTools: opts.allowedTools,
      }),
      ...(opts.disallowedTools !== undefined && {
        disallowedTools: opts.disallowedTools,
      }),
      ...(opts.containment !== undefined && { containment: opts.containment }),
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
    if (status === undefined) return [...this.tasks.values()];
    const result: ClaudeTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === status) result.push(t);
    }
    return result;
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
      // Kill switch — checked at the pending→running transition, so a job
      // queued BEFORE the switch was engaged is refused when its turn comes,
      // and a task already running is never killed. Governed profile:
      // unreadable state refuses (see killSwitchPolicy).
      const ks = readKillSwitch();
      if (ks.engaged) {
        this._refuseTask(id, killSwitchMessage(ks, "subprocess task"));
        continue;
      }
      this._runTask(id);
    }
  }

  /** Land a pending task in `error` without ever starting it. */
  private _refuseTask(id: string, errorMessage: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = "error";
    task.errorMessage = errorMessage;
    task.doneAt = Date.now();
    this.taskCallbacks.delete(id);
    this.log(`[orchestrator] task ${id.slice(0, 8)} refused: ${errorMessage}`);
    this.notifyDone?.(id, task.status);
    this._fireCompletion(id);
    void Promise.resolve(this.checkpoint?.save()).catch((err) => {
      this.log(
        `[orchestrator] checkpoint save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this._pruneHistory();
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

    // The bridge LaunchAgent defaults its WorkingDirectory to $HOME, so
    // `this.workspace` is typically $HOME unless the bridge was started
    // with an explicit --workspace. Resolve a real workspace per task
    // (PATCHWORK_WORKSPACE env, then a .git-ancestor walk) so agent steps
    // don't shell out from $HOME and fail with `fatal: not a git
    // repository` — the dominant `agent_silent_fail` halt cause. #765
    // fixed the --local path (defaultClaudeCodeFn); this closes the
    // bridge-orchestrated path.
    const resolvedWorkspace =
      resolveWorkspaceRoot({ startDir: this.workspace })?.path ??
      this.workspace;

    try {
      // Observation first, then enforcement — in that order, deliberately.
      // The shadow ledger's job is to record what a CANDIDATE policy would have
      // done, and a refused dispatch is exactly the case a candidate policy is
      // being evaluated against. Enforcing first would drop the observation for
      // every refusal, leaving the shadow report blind to the traffic that
      // matters most to it.
      //
      // Read ONCE and handed to both, so the two ledgers cannot describe the
      // same dispatch with different labels.
      const pathClassification = orchestratorPathClassification(
        (
          loadPatchworkConfig() as {
            privacy?: { orchestrator?: { classification?: unknown } };
          }
        ).privacy,
      );
      observeOrchestratorShadow(
        this.driver.name,
        resolvedWorkspace,
        pathClassification,
      );
      // May THROW. Caught below as a non-abort error, so the task lands
      // `error` with the boundary's reason as its message.
      governOrchestratorDispatch(
        this.driver.name,
        resolvedWorkspace,
        pathClassification,
      );
      const result = await this.driver.run({
        prompt: task.prompt,
        contextFiles: task.contextFiles,
        workspace: resolvedWorkspace,
        timeoutMs: task.timeoutMs,
        signal: controller.signal,
        model: task.model,
        startupTimeoutMs: task.startupTimeoutMs,
        systemPrompt: task.systemPrompt,
        providerOptions: {
          effort: task.effort,
          fallbackModel: task.fallbackModel,
          maxBudgetUsd: task.maxBudgetUsd,
          useAnt: task.useAnt,
          mcpAccess: task.mcpAccess,
          // P0-5 — the single hop where typed top-level sandbox fields are
          // repackaged into the untyped providerOptions bag the driver reads.
          sandbox: task.sandbox,
          allowedTools: task.allowedTools,
          disallowedTools: task.disallowedTools,
          containment: task.containment,
        },
        // Phase 0: containment travels typed as well as in the bag, so a
        // driver that reads only ProviderTaskInput.containment still sees it.
        ...(task.containment !== undefined && {
          containment: task.containment,
        }),
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
        task.stderrTail = result.stderrTail ?? result.errorMessage;
        const hasError =
          result.errorMessage !== undefined ||
          (result.exitCode !== undefined && result.exitCode !== 0);
        task.status = hasError ? "error" : "done";
        if (hasError) {
          task.errorMessage =
            result.errorMessage ??
            `Process exited with code ${result.exitCode}`;
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
      void Promise.resolve(this.checkpoint?.save()).catch((err) => {
        // Persistent disk-write failure here means task state is no longer
        // crash-safe. Best-effort persistence — but log so a degraded disk
        // shows up in operator logs instead of failing silently.
        this.log(
          `[orchestrator] checkpoint save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
    const result: PersistedTask[] = [];
    for (const t of this.tasks.values()) {
      // Never the prompt in clear text: `~/.claude/ide/tasks-<port>.json`
      // used to hold every prompt and output verbatim, which is where an
      // interpolated API key or a pasted credential ended up persisting past
      // the process that was handed it.
      const promptEncrypted = encryptPromptForPersistence(t.prompt);
      result.push({
        id: t.id,
        sessionId: t.sessionId,
        promptSha256: createHash("sha256").update(t.prompt).digest("hex"),
        promptPreview: redactKnownSecrets(t.prompt).slice(0, 200),
        ...(promptEncrypted !== undefined && { promptEncrypted }),
        contextFiles: t.contextFiles,
        status: (t.status === "running" ? "interrupted" : t.status) as string,
        output:
          t.output === undefined ? undefined : redactKnownSecrets(t.output),
        errorMessage:
          t.errorMessage === undefined
            ? undefined
            : redactKnownSecrets(t.errorMessage),
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        doneAt: t.doneAt,
        timeoutMs: t.timeoutMs,
        tokenEstimate: t.tokenEstimate,
        ...(t.model !== undefined && { model: t.model }),
        ...(t.effort !== undefined && { effort: t.effort }),
        ...(t.fallbackModel !== undefined && {
          fallbackModel: t.fallbackModel,
        }),
        ...(t.maxBudgetUsd !== undefined && { maxBudgetUsd: t.maxBudgetUsd }),
        ...(t.startupTimeoutMs !== undefined && {
          startupTimeoutMs: t.startupTimeoutMs,
        }),
        ...(t.cancelReason !== undefined && { cancelReason: t.cancelReason }),
        ...(t.stderrTail !== undefined && {
          stderrTail: redactKnownSecrets(t.stderrTail),
        }),
        ...(t.wasAborted !== undefined && { wasAborted: t.wasAborted }),
        ...(t.startupMs !== undefined && { startupMs: t.startupMs }),
        ...(t.systemPrompt !== undefined && { systemPrompt: t.systemPrompt }),
        ...(t.useAnt !== undefined && { useAnt: t.useAnt }),
        ...(t.mcpAccess !== undefined && { mcpAccess: t.mcpAccess }),
        ...(t.sandbox !== undefined && { sandbox: t.sandbox }),
        ...(t.allowedTools !== undefined && { allowedTools: t.allowedTools }),
        ...(t.disallowedTools !== undefined && {
          disallowedTools: t.disallowedTools,
        }),
        ...(t.isAutomationTask !== undefined && {
          isAutomationTask: t.isAutomationTask,
        }),
        ...(t.triggerSource !== undefined && {
          triggerSource: t.triggerSource,
        }),
      });
    }
    return result;
  }

  /** Persist all tasks to disk for cross-session resumability. Best-effort. */
  async persistTasks(port: number): Promise<void> {
    const filePath = join(getConfigDir(), "ide", `tasks-${port}.json`);
    const payload = {
      version: 1,
      savedAt: Date.now(),
      tasks: this._buildTasksPayload(),
    };
    // Atomic write — temp+rename — so a crash mid-write can't truncate
    // tasks file and lose the re-enqueue contract. mode 0o600 owner-only
    // (prompts may contain sensitive code or secrets).
    await writeFileAtomic(filePath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
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
      // SIGTERM mid-write was the worst-case for non-atomic write — a
      // truncated tasks file means loadPersistedTasks silently swallows
      // the parse error and all interrupted-run tasks are lost.
      writeFileAtomicSync(filePath, JSON.stringify(payload, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
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

        const { prompt, recovered: promptRecovered } = restorePrompt(t);
        // Only restore context files that are workspace-confined regular files.
        // The previous check used `abs.startsWith(\`${normalizedWorkspace}/\`)`
        // — hardcoded POSIX separator silently dropped every contextFile on
        // Windows where resolvePath returns backslash paths. Use path.relative
        // so the check is OS-correct.
        const contextFiles: string[] = Array.isArray(t.contextFiles)
          ? t.contextFiles.filter((f: unknown) => {
              if (typeof f !== "string") return false;
              const abs = resolvePath(f);
              const rel = relativePath(normalizedWorkspace, abs);
              // rel === "" means abs IS the workspace root (acceptable).
              // Any segment starting with ".." or an absolute drive-prefixed
              // remainder means abs escaped the workspace.
              if (rel.startsWith("..") || isAbsolutePath(rel)) return false;
              try {
                return fs.lstatSync(abs).isFile();
              } catch {
                return false;
              }
            })
          : [];

        if (reenqueuePending && t.status === "pending") {
          if (!promptRecovered) {
            // Only a preview survived (no master key, foreign file, torn
            // write). Re-running a truncated prompt would be a different
            // task wearing this one's id — surface it as interrupted instead.
            this._restoreTerminalTask(t, prompt, contextFiles, "interrupted");
            overflow++;
            continue;
          }
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
              ...(t.useAnt !== undefined && { useAnt: t.useAnt }),
              ...(t.mcpAccess !== undefined && { mcpAccess: t.mcpAccess }),
              ...(t.sandbox !== undefined && { sandbox: t.sandbox }),
              ...(t.allowedTools !== undefined && {
                allowedTools: t.allowedTools,
              }),
              ...(t.disallowedTools !== undefined && {
                disallowedTools: t.disallowedTools,
              }),
              ...(t.isAutomationTask !== undefined && {
                isAutomationTask: t.isAutomationTask,
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
      ...(t.useAnt !== undefined && { useAnt: t.useAnt }),
      ...(t.mcpAccess !== undefined && { mcpAccess: t.mcpAccess }),
      ...(t.sandbox !== undefined && { sandbox: t.sandbox }),
      ...(t.allowedTools !== undefined && { allowedTools: t.allowedTools }),
      ...(t.disallowedTools !== undefined && {
        disallowedTools: t.disallowedTools,
      }),
      ...(t.isAutomationTask !== undefined && {
        isAutomationTask: t.isAutomationTask,
      }),
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
