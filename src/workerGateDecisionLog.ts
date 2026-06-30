import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./fileLockSync.js";
import type { Logger } from "./logger.js";
import type { Reversibility } from "./workers/actionClass.js";

/**
 * WorkerGateDecisionLog — the immutable record of every worker-autonomy gate
 * decision, with the INPUTS that produced it.
 *
 * The first concrete slice of the "Decision Record" north star
 * (docs/worker-autonomy-policy-gate.md): `decideWorkerAction` computes a rich
 * `WorkerGateDecision` (earned level, ceiling, context-risk de-rate, reason)
 * and — before this log — discarded it, persisting only a human-readable
 * `summary` string into the approval queue. So an autonomous `allow` left NO
 * trail at all, and a `gate` kept only its summary; a decision could not be
 * replayed or explained from the log.
 *
 * This captures the decision + its inputs on BOTH paths (allow AND gate) so an
 * operator can answer "why did the worker (auto-)act / gate here, on what
 * evidence, under which policy version?" — explainable from stored evidence
 * (replay ≠ bit-exact re-execution; the world drifts). Retention is bounded by
 * the rotation caps below (most-recent 10k rows / 1 MB), like the sibling logs;
 * a longer/archival horizon for compliance is a deliberate follow-up, not a
 * promise this file makes today.
 *
 * Same battle-tested JSONL machinery as DecisionTraceLog / RecipeRunLog:
 * append-only + cross-process flock (ADR-0007 torn-row guard) + bounded
 * in-memory ring + size/line rotation + tail-on-read so a sibling bridge's
 * appends become visible. Schema is additive.
 */

export type GateAction = "allow" | "gate";

export interface GateDecisionRecord {
  /** Monotonic sequence id within the process — stable for pagination. */
  seq: number;
  /** ms epoch when the decision was made. */
  decidedAt: number;
  recipeName: string;
  workerId: string;
  toolName: string;
  action: GateAction;
  /** `${domain}:${reversibility}:${blastTier}` — the trust unit. */
  classKey: string;
  domain: string;
  owned: boolean;
  /** "low" | "medium" | "high" (RiskTier, kept as string to decouple). */
  blastTier: string;
  reversibility: Reversibility;
  /** Trust earned on this class as of the decision. */
  earnedLevel: number;
  autonomyCeiling: number;
  /** min(earned, ceiling, contextCeiling), 0 if unowned — what the gate acted on. */
  effectiveLevel: number;
  /** Descending ceiling from live context-risk (present only when supplied). */
  contextCeiling?: number;
  /** Context-risk score 0..1 (present only when a context-risk was resolved). */
  contextRiskScore?: number;
  /** Human reasons the situation was risky (e.g. "huge uncommitted diff"). */
  contextRiskReasons?: string[];
  /** Human-readable rationale for the action. */
  reason: string;
  /** The gate-policy version (thresholds/constants) that produced this row.
   *  Replay is not reproducible without knowing which policy decided. */
  gatePolicyVersion: string;
}

export type RecordGateDecisionInput = Omit<
  GateDecisionRecord,
  "seq" | "decidedAt"
>;

const DEFAULT_MEMORY_CAP = 2_000;
const MAX_PERSIST_BYTES = 1024 * 1024; // 1 MB
const MAX_PERSIST_LINES = 10_000;
const MAX_REASON_LEN = 1_000;
const MAX_CONTEXT_REASONS = 16;

export interface WorkerGateDecisionLogOptions {
  dir: string;
  logger?: Logger;
  memoryCap?: number;
  now?: () => number;
}

export interface GateDecisionQuery {
  workerId?: string;
  classKey?: string;
  recipeName?: string;
  action?: GateAction;
  /** Only return rows with seq > after. */
  after?: number;
  /** Only return rows with decidedAt >= since. */
  since?: number;
  limit?: number;
}

export class WorkerGateDecisionLog {
  private records: GateDecisionRecord[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private readonly now: () => number;
  /** Byte offset up to which `file` has been loaded (ADR-0007 tail-on-read). */
  private lastReadOffset = 0;

  constructor(private readonly opts: WorkerGateDecisionLogOptions) {
    this.file = path.join(opts.dir, "worker_gate_decisions.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.now = opts.now ?? Date.now;
    try {
      mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      opts.logger?.warn?.(
        `[gate-decision-log] could not create ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.loadExisting();
  }

  /**
   * Record one gate decision. Validates the required identity fields and clips
   * free-form text so a runaway reason can't bloat the audit log. Returns the
   * stored record. The caller appends this fail-soft (a logging failure must
   * never block the gate) — so this throws only on programmer error (missing
   * required fields), which the caller catches.
   */
  record(input: RecordGateDecisionInput): GateDecisionRecord {
    const recipeName = input.recipeName.trim();
    const workerId = input.workerId.trim();
    const toolName = input.toolName.trim();
    const classKey = input.classKey.trim();
    if (!recipeName) throw new Error("recipeName is required");
    if (!workerId) throw new Error("workerId is required");
    if (!toolName) throw new Error("toolName is required");
    if (!classKey) throw new Error("classKey is required");
    if (input.action !== "allow" && input.action !== "gate") {
      throw new Error(`invalid action: ${String(input.action)}`);
    }

    const reasons = (input.contextRiskReasons ?? [])
      .map((r) => String(r).trim())
      .filter((r) => r.length > 0)
      .slice(0, MAX_CONTEXT_REASONS);

    this.seq += 1;
    const rec: GateDecisionRecord = {
      seq: this.seq,
      decidedAt: this.now(),
      recipeName,
      workerId,
      toolName,
      action: input.action,
      classKey,
      domain: input.domain,
      owned: input.owned,
      blastTier: input.blastTier,
      reversibility: input.reversibility,
      earnedLevel: input.earnedLevel,
      autonomyCeiling: input.autonomyCeiling,
      effectiveLevel: input.effectiveLevel,
      ...(input.contextCeiling !== undefined && {
        contextCeiling: input.contextCeiling,
      }),
      ...(input.contextRiskScore !== undefined && {
        contextRiskScore: input.contextRiskScore,
      }),
      ...(reasons.length > 0 && { contextRiskReasons: reasons }),
      reason: input.reason.slice(0, MAX_REASON_LEN),
      gatePolicyVersion: input.gatePolicyVersion,
    };
    this.records.push(rec);
    if (this.records.length > this.memoryCap) {
      this.records.splice(0, this.records.length - this.memoryCap);
    }
    this.append(rec);
    return rec;
  }

  query(q: GateDecisionQuery = {}): GateDecisionRecord[] {
    this.tailDisk();
    const out: GateDecisionRecord[] = [];
    for (const r of this.records) {
      if (q.workerId && r.workerId !== q.workerId) continue;
      if (q.classKey && r.classKey !== q.classKey) continue;
      if (q.recipeName && r.recipeName !== q.recipeName) continue;
      if (q.action && r.action !== q.action) continue;
      if (q.after !== undefined && r.seq <= q.after) continue;
      if (q.since !== undefined && r.decidedAt < q.since) continue;
      out.push(r);
    }
    out.sort((a, b) => b.seq - a.seq);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1_000);
    return out.slice(0, limit);
  }

  size(): number {
    return this.records.length;
  }

  private append(rec: GateDecisionRecord): void {
    try {
      try {
        const st = statSync(this.file);
        if (st.size > MAX_PERSIST_BYTES) this.rotateDisk();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
      // Cross-process flock around the append (ADR-0007): two bridges sharing
      // $HOME can interleave bytes within one JSONL row; the torn line then
      // fails JSON.parse and is silently skipped on every reader.
      withFileLockSync(this.file, () => {
        appendFileSync(this.file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
        // Advance the tail offset past our own write so the next query() doesn't
        // re-read this row (we already pushed it in `record`).
        try {
          this.lastReadOffset = statSync(this.file).size;
        } catch {
          /* the next tailDisk() reloads cleanly if this ever fails */
        }
      });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[gate-decision-log] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Trim to the most recent MAX_PERSIST_LINES / MAX_PERSIST_BYTES. Best-effort. */
  private rotateDisk(): void {
    try {
      const raw = readFileSync(this.file, "utf-8");
      let lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length > MAX_PERSIST_LINES)
        lines = lines.slice(-MAX_PERSIST_LINES);
      let joined = lines.join("\n");
      while (joined.length + 1 > MAX_PERSIST_BYTES && lines.length > 1) {
        lines = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
        joined = lines.join("\n");
      }
      if (lines.length === 1 && joined.length + 1 > MAX_PERSIST_BYTES) {
        this.opts.logger?.warn?.(
          `[gate-decision-log] rotate dropped 1 oversized row (${joined.length} bytes)`,
        );
        lines = [];
        joined = "";
      }
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, joined.length > 0 ? `${joined}\n` : "", {
        mode: 0o600,
      });
      try {
        renameSync(tmp, this.file);
      } catch (renameErr) {
        if (
          process.platform === "win32" &&
          (renameErr as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          try {
            unlinkSync(this.file);
          } catch {
            /* best-effort */
          }
          renameSync(tmp, this.file);
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      this.opts.logger?.warn?.(
        `[gate-decision-log] rotate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private loadExisting(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      this.lastReadOffset = 0;
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf-8");
    } catch (err) {
      this.opts.logger?.warn?.(
        `[gate-decision-log] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.consumeRawJsonl(raw);
    this.lastReadOffset = size;
    if (this.records.length > this.memoryCap) {
      this.records.splice(0, this.records.length - this.memoryCap);
    }
  }

  /** Read rows appended since `lastReadOffset` and merge them (ADR-0007). */
  private tailDisk(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size === this.lastReadOffset) return;
    if (size < this.lastReadOffset) {
      // Rotated/truncated by a sibling — full reload.
      this.records.length = 0;
      this.lastReadOffset = 0;
      this.loadExisting();
      return;
    }
    let buf: Buffer;
    try {
      const fd = openSync(this.file, "r");
      try {
        const len = size - this.lastReadOffset;
        buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, this.lastReadOffset);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.opts.logger?.warn?.(
        `[gate-decision-log] tail read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.consumeRawJsonl(buf.toString("utf-8"));
    this.lastReadOffset = size;
    if (this.records.length > this.memoryCap) {
      this.records.splice(0, this.records.length - this.memoryCap);
    }
  }

  private consumeRawJsonl(raw: string): void {
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as GateDecisionRecord;
        if (
          typeof parsed.seq !== "number" ||
          typeof parsed.workerId !== "string" ||
          typeof parsed.toolName !== "string" ||
          (parsed.action !== "allow" && parsed.action !== "gate")
        ) {
          continue;
        }
        this.records.push(parsed);
        if (parsed.seq > this.seq) this.seq = parsed.seq;
      } catch {
        // skip malformed row
      }
    }
  }
}
