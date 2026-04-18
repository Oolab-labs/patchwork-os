import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

/**
 * DecisionTraceLog — agent-authored trace of "I fixed X by doing Y".
 *
 * Writers call `ctxSaveTrace(ref, problem, solution)` after resolving a
 * task; readers call `ctxQueryTraces(traceType: "decision")` or see a
 * digest on session start. Complements CommitIssueLinkLog (system-
 * generated links) and RecipeRunLog (orchestrator runs) with durable
 * problem/solution knowledge — the Phase 3 moat material.
 *
 * JSONL append + bounded in-memory ring. Same pattern as the two other
 * logs; schema is additive. Tags are free-form short labels (max 10 per
 * trace, 32 chars each) so agents can search by "flaky-test" / "perf" /
 * "security" without a taxonomy commitment.
 */

export interface DecisionTrace {
  /** Monotonic sequence id within the process — stable for pagination. */
  seq: number;
  /** ms epoch when the trace was recorded. */
  createdAt: number;
  /** The thing the trace is about: issue ref, PR ref, commit SHA, or free text. */
  ref: string;
  /** One-line description of the problem (max 500 chars). */
  problem: string;
  /** One-line description of the resolution (max 500 chars). */
  solution: string;
  /** Workspace where the trace was recorded. */
  workspace: string;
  /** Optional free-form tags (max 10, each ≤32 chars). */
  tags?: string[];
  /** Optional session id so we can attribute traces back to a run. */
  sessionId?: string;
}

const DEFAULT_MEMORY_CAP = 2_000;
const MAX_PROBLEM_LEN = 500;
const MAX_SOLUTION_LEN = 500;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 32;

export interface DecisionTraceLogOptions {
  dir: string;
  logger?: Logger;
  memoryCap?: number;
  now?: () => number;
}

export interface DecisionQuery {
  ref?: string;
  tag?: string;
  workspace?: string;
  sessionId?: string;
  /** Only return rows with seq > after. */
  after?: number;
  /** Only return rows with createdAt >= since. */
  since?: number;
  limit?: number;
}

export interface RecordDecisionInput {
  ref: string;
  problem: string;
  solution: string;
  workspace: string;
  tags?: string[];
  sessionId?: string;
}

export class DecisionTraceLog {
  private traces: DecisionTrace[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private readonly now: () => number;

  constructor(private readonly opts: DecisionTraceLogOptions) {
    this.file = path.join(opts.dir, "decision_traces.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.now = opts.now ?? Date.now;
    try {
      mkdirSync(opts.dir, { recursive: true });
    } catch (err) {
      opts.logger?.warn?.(
        `[dtrace-log] could not create ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.loadExisting();
  }

  /**
   * Record a new decision trace. Validates required fields + clips the
   * free-form text to avoid the agent writing a whole transcript.
   * Returns the stored trace or throws on invalid input.
   */
  record(input: RecordDecisionInput): DecisionTrace {
    const ref = input.ref.trim();
    const problem = input.problem.trim();
    const solution = input.solution.trim();
    if (!ref) throw new Error("ref is required");
    if (!problem) throw new Error("problem is required");
    if (!solution) throw new Error("solution is required");
    if (problem.length > MAX_PROBLEM_LEN) {
      throw new Error(`problem exceeds ${MAX_PROBLEM_LEN} chars`);
    }
    if (solution.length > MAX_SOLUTION_LEN) {
      throw new Error(`solution exceeds ${MAX_SOLUTION_LEN} chars`);
    }

    const tags = (input.tags ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= MAX_TAG_LEN)
      .slice(0, MAX_TAGS);

    this.seq += 1;
    const trace: DecisionTrace = {
      seq: this.seq,
      createdAt: this.now(),
      ref,
      problem,
      solution,
      workspace: input.workspace,
      ...(tags.length > 0 && { tags }),
      ...(input.sessionId && { sessionId: input.sessionId }),
    };
    this.traces.push(trace);
    if (this.traces.length > this.memoryCap) {
      this.traces.splice(0, this.traces.length - this.memoryCap);
    }
    this.append(trace);
    return trace;
  }

  query(q: DecisionQuery = {}): DecisionTrace[] {
    let out = this.traces;
    if (q.ref) {
      const needle = q.ref;
      out = out.filter((t) => t.ref === needle || t.ref.includes(needle));
    }
    if (q.tag) {
      const needle = q.tag;
      out = out.filter((t) => t.tags?.includes(needle) ?? false);
    }
    if (q.workspace) out = out.filter((t) => t.workspace === q.workspace);
    if (q.sessionId) out = out.filter((t) => t.sessionId === q.sessionId);
    if (q.after !== undefined) {
      const after = q.after;
      out = out.filter((t) => t.seq > after);
    }
    if (q.since !== undefined) {
      const since = q.since;
      out = out.filter((t) => t.createdAt >= since);
    }
    out = [...out].sort((a, b) => b.seq - a.seq);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1_000);
    return out.slice(0, limit);
  }

  size(): number {
    return this.traces.length;
  }

  private append(trace: DecisionTrace): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(trace)}\n`, { mode: 0o600 });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[dtrace-log] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private loadExisting(): void {
    try {
      statSync(this.file);
    } catch {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf-8");
    } catch (err) {
      this.opts.logger?.warn?.(
        `[dtrace-log] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as DecisionTrace;
        if (
          typeof parsed.seq !== "number" ||
          typeof parsed.ref !== "string" ||
          typeof parsed.problem !== "string" ||
          typeof parsed.solution !== "string"
        ) {
          continue;
        }
        this.traces.push(parsed);
        if (parsed.seq > this.seq) this.seq = parsed.seq;
      } catch {
        // skip malformed row
      }
    }
    if (this.traces.length > this.memoryCap) {
      this.traces.splice(0, this.traces.length - this.memoryCap);
    }
  }
}
