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

/**
 * `forbid` is a third TERMINAL state, not a stronger gate: no earned trust and
 * no human approval unlocks it (ADR-0017). Readers that predate it refuse
 * rather than misreport — see `describeGateAction` / `gateOutcomeFor`.
 */
export type GateAction = "allow" | "gate" | "forbid";

/**
 * Who allowed (or is accountable for) a decision — a SNAPSHOT, not a reference.
 *
 * Denormalised deliberately. The roster changes: people are renamed, change
 * role, and are deactivated. A record that stored only an id and resolved it at
 * read time would silently rewrite history — "approved by Anna Reyes (Auditor)"
 * for a decision she made as an Approver two years earlier. An audit record has
 * to stay true to the moment it describes, so it carries the name as it was.
 *
 * `id` is still the stable join key for "everything this member decided".
 */
export interface GateDecisionActor {
  /** Stable member id from the workspace roster. */
  id: string;
  /** Human or worker at the time of the decision. */
  kind: "human" | "worker";
  /** Display name as it was when the decision was made. */
  displayName?: string;
}

export interface GateDecisionRecord {
  /**
   * Short id of the workspace this decision was made in (`src/workspaceId.ts`).
   *
   * TAG, not a scope: evidence must outlive the workspace it describes, so it
   * is never filtered by this — only attributed. ABSENT on records written
   * before the field existed, and never backfilled: "nobody recorded this" must
   * stay distinguishable from "we do not know", the same rule `actor` follows.
   */
  workspaceId?: string;

  /**
   * Record level — the writer's claim about which fields this row is
   * guaranteed to carry. Stamped by `record()`, never by a caller.
   *
   * ABSENT means the row carries NO claim, and nothing may be inferred from
   * which optional fields it lacks. That is the sentinel: it is the only
   * pre-sentinel signal obtainable without touching the past, and it is
   * unrepairable by construction. Do NOT default it on read — `parsed.rv ?? 0`
   * is a backfill performed on every load, invisible in the file itself.
   *
   * NOT monotone in file order: several writers share this file, so an older
   * bridge can append an un-levelled row after a newer one. It therefore says
   * nothing about time, and a reader must never render it as "pre-dates" —
   * that exact conflation shipped once already for `actor`.
   */
  rv?: number;
  /**
   * The run this decision belongs to: `taskId`, verbatim, as written to
   * `runs.jsonl` / `run_steps.jsonl`. Never `seq`, which is a per-instance
   * counter over a shared file and collides (255 distinct across 272 live rows).
   *
   * At `rv >= 1` its absence is a WRITER DEFECT, not a state. Every gate
   * decision happens inside a run — `buildWorkerAutonomyGate` is wired from one
   * site, inside `fireYamlRecipe` — so "recorded, and legitimately had no run"
   * cannot occur here. A scheme that could express it would only be able to
   * express it falsely.
   */
  correlationId?: string;
  /**
   * Stable id of the rule that decided this — see `GateRuleId` in
   * `workers/workerGate.ts`. The `reason` beside it is prose and may be
   * reworded; this is the half a receipt cites and a reader groups by.
   *
   * At `rv >= 2` its absence is a WRITER DEFECT, not a state, for the same
   * reason `correlationId`'s is at `rv >= 1`: every decision takes exactly one
   * terminal branch, so "decided, and legitimately had no rule" cannot occur.
   * Rows at `rv < 2` predate the field and are not backfilled.
   */
  ruleId?: string;

  /** Monotonic sequence id within the process — stable for pagination. */
  seq: number;
  /** ms epoch when the decision was made. */
  decidedAt: number;
  recipeName: string;
  workerId: string;
  toolName: string;
  action: GateAction;
  /** `${domain}:${reversibility}:${blastTier}`, plus `:${magnitudeBand}` for
   *  value-bearing domains — the trust unit. */
  classKey: string;
  domain: string;
  owned: boolean;
  /** "low" | "medium" | "high" (RiskTier, kept as string to decouple). */
  blastTier: string;
  /** Value bucket for value-bearing domains (e.g. "band<=50"); absent
   *  otherwise, and absent on every pre-worker-ramp-v2 record. Optional so an
   *  older reader is unaffected. */
  magnitudeBand?: string;
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
  /**
   * Who this decision is attributed to (ADR-0017). Optional, and absent on
   * every record written before actors existed — that absence is meaningful
   * ("nobody recorded this") and must stay distinguishable from a synthesized
   * "unknown", so it is never backfilled.
   *
   * For an autonomous allow this is the worker itself. For a gated decision it
   * becomes the approving human once the approval path carries an identity —
   * which it cannot yet, because `ApprovalQueue` holds its entries in memory
   * and they do not survive a restart. (Its TTLs are risk-tiered and
   * configurable since #1214 — low 5 min / medium 1 h / high 4 h — so expiry is
   * not the blocker; durability is.)
   */
  actor?: GateDecisionActor;
  /**
   * Set when a STANDING PERMISSION answered this decision: the gate said
   * `gate`, and a pre-recorded human approval converted it to flow without
   * queueing (src/butler/standingPermission.ts).
   *
   * Read this field as load-bearing: `action: "gate"` WITH this id present
   * means the action went ahead and no human was asked at the time. Without
   * it, `action: "gate"` means what it always did — somebody was asked.
   *
   * Deliberately NOT an `actor`. The grant names its own `grantedBy`, which is
   * `null` until per-member auth exists (ADR-0020), and synthesizing an actor
   * from a permission would write a claim about a person into an audit record
   * on no evidence. The id points at the grant; the grant states what is known
   * about who made it.
   */
  standingPermissionId?: string;
  /** The gate-policy version (thresholds/constants) that produced this row.
   *  Replay is not reproducible without knowing which policy decided. */
  gatePolicyVersion: string;
}

/**
 * The current record level. Bump ONLY when adding a new guarantee, and never
 * retroactively: a row already on disk claiming level N is a permanent
 * assertion about what level N meant when it was written, so widening level N
 * later falsifies rows nobody can go back and fix.
 */
/**
 * Row-schema version. What each level GUARANTEES, cumulatively:
 *
 *   1 — the row carries `correlationId` (the run's `taskId`).
 *   2 — the row additionally carries `ruleId` (which rule decided it).
 *
 * Bumped only when a reader may newly RELY on a field being present, never for
 * a merely additive one. `correlationOf` does not skip rows from an unknown
 * version, so a bump adds a guarantee without stranding any existing reader.
 */
export const GATE_RECORD_VERSION = 2 as const;

/**
 * `rv` is excluded, and that exclusion is load-bearing rather than tidy. If a
 * caller could supply it, the level would be a claim made by whoever happened
 * to call `record()` rather than by the writer that actually knows which fields
 * it stamps — and the whole scheme rests on the level being trustworthy.
 */
export type RecordGateDecisionInput = Omit<
  GateDecisionRecord,
  "seq" | "decidedAt" | "rv"
>;

const DEFAULT_MEMORY_CAP = 2_000;
export const MAX_PERSIST_BYTES = 1024 * 1024; // 1 MB
const MAX_PERSIST_LINES = 10_000;
/**
 * Low-water mark for rotation, as a fraction of the cap. The cap is the
 * TRIGGER; this is the TARGET. The gap between them is what stops rotation from
 * running on every append once the file is full — see `rotateDisk`.
 */
const ROTATE_TARGET_RATIO = 0.9;
const MAX_REASON_LEN = 1_000;
const MAX_CONTEXT_REASONS = 16;

export interface WorkerGateDecisionLogOptions {
  dir: string;
  /**
   * Only `warn` is ever called (`logger?.warn?.(…)` at every site), so the
   * option asks for only that — matching `ButlerFactStore` and
   * `permissionStore`, which take the same shape for the same reason.
   *
   * It used to demand the full `Logger`. A real caller passing one still
   * satisfies this structurally, but the wide type made a `{ warn }` object
   * a type error in tests while being indistinguishable at runtime — and the
   * strict `tsconfig.tests.core.json` ratchet is where that surfaced, not the
   * default `npm run typecheck`.
   */
  logger?: { warn?: (msg: string) => void };
  memoryCap?: number;
  /**
   * Byte cap before rotation, defaulting to `MAX_PERSIST_BYTES`.
   *
   * Injectable for the same reason `memoryCap` is: a test that must observe
   * rotation should not have to write a real megabyte through a lock-guarded
   * append on every row. The first version of the rotation test did exactly
   * that — ~3,400 locked appends across four cases — which is merely slow on
   * Linux and a plausible timeout on Windows.
   */
  maxPersistBytes?: number;
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

/**
 * The three terminal actions a Decision Record may carry (ADR-0017).
 *
 * Shared because the writer and the reader each hardcoded their own list and
 * drifted: `record()` validated all three while the loader accepted only
 * `allow` and `gate`, so a `forbid` row was written correctly and then dropped
 * by every subsequent read. It survived in the writing process's memory ring
 * and vanished at the next restart — leaving the one state whose whole purpose
 * is to be visible and unappealable invisible in `gate explain`, in
 * `GET /gate/decisions` and on the dashboard.
 *
 * One literal, two call sites. The same reason `AGENT_STEP_TOOL` lives in one
 * place: two independent copies of a list is not a duplication smell here, it
 * is the mechanism of the bug.
 */
export const GATE_ACTIONS = ["allow", "gate", "forbid"] as const;

export function isGateAction(v: unknown): v is GateDecisionRecord["action"] {
  return (
    typeof v === "string" && (GATE_ACTIONS as readonly string[]).includes(v)
  );
}

/**
 * What a row says about the run it belongs to.
 *
 * Three states, and the point of the whole scheme is that they stay distinct:
 *
 *  - `unclaimed` — the row carries no record level. Written before the level
 *    existed, OR by a bridge still running older code. Those two are NOT
 *    distinguishable and must never be conflated in prose: say "no claim
 *    recorded", never "pre-dates".
 *  - `linked`    — the row names its run.
 *  - `defect`    — the row claims a level that guarantees a correlation id and
 *    does not carry one. A writer bug, not a state of the world.
 *
 * There is deliberately NO "recorded, legitimately had no run". Every gate
 * decision happens inside a run, so such a row would be a false claim, and a
 * vocabulary that can express something untrue eventually will.
 *
 * `runExists` is optional because most callers have no run log to hand. Absent,
 * a row that names a run is reported `linked` WITHOUT checking — "we did not
 * look" is not the same as "we looked and found it", so the caller is never
 * told more than was actually verified.
 */
export type CorrelationState =
  | { state: "unclaimed" }
  | { state: "linked"; taskId: string }
  | { state: "unresolved"; taskId: string }
  | { state: "defect"; rv: number };

export function correlationOf(
  rec: Pick<GateDecisionRecord, "rv" | "correlationId">,
  runExists?: (taskId: string) => boolean,
): CorrelationState {
  if (typeof rec.rv !== "number" || !Number.isFinite(rec.rv)) {
    return { state: "unclaimed" };
  }
  const id = rec.correlationId;
  if (typeof id === "string" && id.length > 0) {
    if (!runExists) return { state: "linked", taskId: id };
    return runExists(id)
      ? { state: "linked", taskId: id }
      : { state: "unresolved", taskId: id };
  }
  return { state: "defect", rv: rec.rv };
}

/**
 * Which rule a row names, with the same three-way honesty as `correlationOf`.
 *
 *  - `unversioned` — written before rules were named. NOT "no rule applied":
 *    one did, nobody recorded which. Never render it as "unknown rule".
 *  - `named`       — the row names its rule.
 *  - `defect`      — the row claims a level that guarantees a rule id and does
 *    not carry one. A writer bug, not a state of the world.
 *
 * As with `correlationOf` there is deliberately NO "decided, legitimately had
 * no rule": every decision takes exactly one terminal branch, so such a row
 * would be a false claim.
 */
export type RuleState =
  | { state: "unversioned" }
  | { state: "named"; ruleId: string }
  | { state: "defect"; rv: number };

export function ruleOf(
  rec: Pick<GateDecisionRecord, "rv" | "ruleId">,
): RuleState {
  if (typeof rec.rv !== "number" || !Number.isFinite(rec.rv) || rec.rv < 2) {
    return { state: "unversioned" };
  }
  const id = rec.ruleId;
  if (typeof id === "string" && id.length > 0)
    return { state: "named", ruleId: id };
  return { state: "defect", rv: rec.rv };
}

export class WorkerGateDecisionLog {
  private records: GateDecisionRecord[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private readonly maxBytes: number;
  private readonly rotateTarget: number;
  private readonly now: () => number;
  /** Byte offset up to which `file` has been loaded (ADR-0007 tail-on-read). */
  private lastReadOffset = 0;

  constructor(private readonly opts: WorkerGateDecisionLogOptions) {
    this.file = path.join(opts.dir, "worker_gate_decisions.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.maxBytes =
      opts.maxPersistBytes && opts.maxPersistBytes > 0
        ? opts.maxPersistBytes
        : MAX_PERSIST_BYTES;
    this.rotateTarget = Math.max(
      1,
      Math.floor(this.maxBytes * ROTATE_TARGET_RATIO),
    );
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
    if (!isGateAction(input.action)) {
      throw new Error(`invalid action: ${String(input.action)}`);
    }

    const reasons = (input.contextRiskReasons ?? [])
      .map((r) => String(r).trim())
      .filter((r) => r.length > 0)
      .slice(0, MAX_CONTEXT_REASONS);

    // An actor with a blank id would attribute the decision to nobody while
    // LOOKING attributed, which is worse than leaving it absent. Drop it.
    const actor =
      input.actor && String(input.actor.id).trim() !== ""
        ? {
            id: String(input.actor.id).trim(),
            kind:
              input.actor.kind === "worker"
                ? ("worker" as const)
                : ("human" as const),
            ...(input.actor.displayName &&
            String(input.actor.displayName).trim() !== ""
              ? {
                  displayName: String(input.actor.displayName)
                    .trim()
                    .slice(0, 200),
                }
              : {}),
          }
        : undefined;

    this.seq += 1;
    const rec: GateDecisionRecord = {
      seq: this.seq,
      decidedAt: this.now(),
      rv: GATE_RECORD_VERSION,
      // `correlationId` and `workspaceId` are copied EXPLICITLY because this
      // literal enumerates every field rather than spreading `input`. That is a
      // deliberate shape — a spread would let an unvetted caller field reach
      // disk — but it also means a new field is silently dropped until someone
      // adds a line here.
      //
      // `workspaceId` was exactly that: `recipeOrchestration` has stamped it on
      // every decision since the workspace-tag work landed, and this literal
      // never copied it, so 0 of 272 rows in the live ledger carry one. The tag
      // was wired end to end and thrown away by the last step.
      ...(input.correlationId && { correlationId: input.correlationId }),
      ...(input.workspaceId && { workspaceId: input.workspaceId }),
      // `ruleId` is the third field this literal has had to be told about.
      // Copied conditionally, like `correlationId`: the writer cannot force a
      // caller to supply one, so an absent id at rv>=2 is surfaced by
      // `ruleOf` as a DEFECT rather than silently written as nothing.
      ...(input.ruleId && { ruleId: input.ruleId }),
      recipeName,
      workerId,
      toolName,
      action: input.action,
      classKey,
      domain: input.domain,
      owned: input.owned,
      blastTier: input.blastTier,
      ...(input.magnitudeBand && { magnitudeBand: input.magnitudeBand }),
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
      ...(actor && { actor }),
      ...(input.standingPermissionId && {
        standingPermissionId: input.standingPermissionId,
      }),
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
        if (st.size > this.maxBytes) this.rotateDisk();
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

  /** Trim to the most recent MAX_PERSIST_LINES / `this.maxBytes`. Best-effort. */
  private rotateDisk(): void {
    try {
      const raw = readFileSync(this.file, "utf-8");
      let lines = raw.split("\n").filter((l) => l.trim());
      const before = lines.length;
      if (lines.length > MAX_PERSIST_LINES)
        lines = lines.slice(-MAX_PERSIST_LINES);

      // Trim to fit, newest-first, dropping only what the cap actually
      // requires.
      //
      // This used to halve: `lines.slice(-floor(length / 2))` inside a `while`,
      // so crossing the cap by one row discarded ~50% of the file and a second
      // pass could take ~75%. Measured on a synthetic fill, the old code left
      // 525,829 bytes of a 1 MB budget — half the ledger destroyed to reclaim
      // one row. This file is the autonomy gate's trust evidence and its audit
      // trail, so that was 50% of both.
      //
      // Byte length, not string length: rotation is TRIGGERED on `st.size`
      // (real bytes) but the old arithmetic used `.length` (UTF-16 code units),
      // so a reason containing non-ASCII could leave the file over a cap whose
      // own name says bytes.
      //
      // Trims to ROTATE_TARGET_BYTES, not to the cap. Trimming to exactly the
      // cap looks tidier and is much worse: `append` rotates when the file is
      // over the cap and then writes its row, so a file sitting exactly at the
      // limit rotates on EVERY subsequent append — dropping one row and
      // emitting one warning each time, forever. Measured while building this:
      // 826 rotations and 826 identical warnings across one fill. A high-water
      // trigger needs a low-water target, and a warning that fires on every
      // write is one nobody reads.
      let budget = this.rotateTarget;
      let keepFrom = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const cost = Buffer.byteLength(lines[i] as string, "utf8") + 1;
        if (cost > budget) break;
        budget -= cost;
        keepFrom = i;
      }
      lines = lines.slice(keepFrom);
      let joined = lines.join("\n");

      const dropped = before - lines.length;
      if (dropped > 0) {
        // Say the COUNT, not just that it happened.
        //
        // Rotation deletes oldest-first, which is exactly the population of
        // rows lacking any newer field. So a coverage measure over this file
        // converges toward 1.0 BY DELETION, and "98% of decisions carry a run
        // id" would read identically whether the ledger improved or ate its own
        // counter-examples. Without this number a denominator computed here is
        // not merely imprecise, it is confidently backwards.
        this.opts.logger?.warn?.(
          `[gate-decision-log] rotate dropped ${dropped} of ${before} row(s) (oldest first) to get under ${this.rotateTarget} bytes — coverage figures computed over this file exclude them`,
        );
      }
      if (lines.length === 1 && joined.length + 1 > this.maxBytes) {
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
          // Narrowed, not removed: a genuinely unrecognised action is still a
          // malformed row and is still skipped.
          !isGateAction(parsed.action)
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

/**
 * Render one `GateDecisionRecord` as plain-English prose — the "explain this
 * decision" formatter behind `patchwork gate explain`. Every field it prints
 * is already on the record (no new data, no gate-logic change); this exists
 * because today the only way to read a decision is to know the JSONL schema
 * and grep the file by hand.
 */
/**
 * Render a decision's action for a human.
 *
 * Exhaustive by construction, with an explicit unknown branch. This log is
 * append-only and read cross-process ([ADR-0007](../docs/adr/0007-multi-bridge-jsonl-concurrency.md)),
 * so an older reader can meet a record written by a NEWER bridge — the
 * hazardous direction, not the reverse.
 *
 * The previous form was `action === "allow" ? ALLOWED : GATED`. That never
 * threw, which is why it looked safe; the actual failure was worse. An
 * unrecognised action fell into the `else` and was reported as "GATED (asked
 * for approval)" — telling an operator the action was awaiting a decision when,
 * for the `forbid` state [ADR-0017](../docs/adr/0017-decision-record-actor-and-forbid.md)
 * introduces, no approval can ever unlock it. A safety control that misreports
 * itself in the permissive direction is worse than one that fails loudly.
 *
 * Ships ahead of `forbid` itself, per ADR-0017: the fallback must exist in
 * readers before the first record carrying the new value is ever written.
 */
export function describeGateAction(action: string): string {
  switch (action) {
    case "allow":
      return "ALLOWED";
    case "gate":
      return "GATED (asked for approval)";
    case "forbid":
      return "FORBIDDEN (no approval can unlock this)";
    default:
      return `UNRECOGNISED ACTION "${action}" — this record was written by a newer Patchwork; upgrade to read it correctly`;
  }
}

/**
 * Why does this row name nobody?
 *
 * The line was previously the single unconditional string "not recorded
 * (pre-dates actor attribution)". That is true only for `allow`. An actor is
 * stamped ONLY on `allow` (`recipeOrchestration.ts`), and deliberately so:
 * on `gate` the approving human is not known at decision time, and on `forbid`
 * nobody acted at all. Those absences are CURRENT POLICY, not history.
 *
 * Measured on the live ledger 2026-08-25: of 272 rows, 47 were `gate`, and every
 * one of them was told it pre-dated a feature that was working correctly. That
 * is the collapse this module's own doctrine exists to prevent — "nobody
 * recorded this" made indistinguishable from "we do not know" — and it is worse
 * than an omission, because an omitted line invites the question while this one
 * answered it wrongly.
 *
 * Explaining an absence is not the same as filling it. Nothing here synthesises
 * an actor, and no row's stored data changes; only what the reader is told.
 */
function attributionAbsenceReason(
  action: GateDecisionRecord["action"],
): string {
  switch (action) {
    case "gate":
      return "nobody — a gated decision records no actor by design, because the approving human is not known when the decision is made";
    case "forbid":
      return "nobody — workspace policy refused, so no party acted";
    default:
      return "not recorded — an autonomous allow normally names the worker, so this row is from before that was stamped";
  }
}

/**
 * Render the rule for a human, preserving the three states `ruleOf` draws.
 *
 * A pre-rule row must NEVER read as "no rule applied" — one did, nobody
 * recorded which — and a row that promises an id and lacks one must read as a
 * writer bug rather than as an absence, or the defect is invisible in the one
 * place an operator actually looks.
 */
function describeRule(rec: GateDecisionRecord): string {
  const r = ruleOf(rec);
  if (r.state === "named") return r.ruleId;
  if (r.state === "defect") {
    return `MISSING — the row claims rv ${r.rv}, which guarantees one (writer defect)`;
  }
  return "not recorded — this row predates named rules";
}

export function formatGateDecision(rec: GateDecisionRecord): string {
  const when = new Date(rec.decidedAt).toISOString();
  const verb = describeGateAction(rec.action);
  const lines: string[] = [
    `${when} — ${rec.workerId} → ${rec.toolName} (${rec.classKey})`,
    `  Result: ${verb}`,
    `  Rule: ${describeRule(rec)}`,
    `  Owned by this worker: ${rec.owned ? "yes" : "no"}`,
    `  Earned trust level: L${rec.earnedLevel} (autonomy ceiling L${rec.autonomyCeiling})`,
  ];
  if (rec.contextCeiling !== undefined) {
    const score =
      rec.contextRiskScore !== undefined
        ? ` (risk score ${rec.contextRiskScore.toFixed(2)})`
        : "";
    lines.push(`  Situational risk ceiling: L${rec.contextCeiling}${score}`);
    if (rec.contextRiskReasons?.length) {
      lines.push(`    Reasons: ${rec.contextRiskReasons.join(", ")}`);
    }
  }
  if (rec.actor) {
    const who = rec.actor.displayName
      ? `${rec.actor.displayName} (${rec.actor.id})`
      : rec.actor.id;
    lines.push(`  Attributed to: ${who} — ${rec.actor.kind}`);
  } else {
    // Say it out loud — a record that simply omits the line reads as though
    // attribution was not applicable. But WHY it is absent depends on the
    // action, and one unconditional string collapsed two different absences
    // into one. See `attributionAbsenceReason`.
    lines.push(`  Attributed to: ${attributionAbsenceReason(rec.action)}`);
  }
  lines.push(
    `  Effective level used for this decision: L${rec.effectiveLevel}`,
    `  Why: ${rec.reason}`,
    `  Recipe: ${rec.recipeName} · Policy: ${rec.gatePolicyVersion}`,
  );
  return lines.join("\n");
}

/** Render a most-recent-first list of decisions (e.g. `query()`'s output) as
 *  a simple chronological history — the same formatter, one entry per record,
 *  separated for readability. Empty input renders an empty string; callers
 *  print their own "no decisions found" message. */
export function formatGateDecisionHistory(recs: GateDecisionRecord[]): string {
  return recs.map(formatGateDecision).join("\n\n");
}

/** One field that changed between two decisions on the same worker × class. */
export interface GateDecisionFieldDiff {
  field: string;
  from: string;
  to: string;
}

/** Fields compared by `diffGateDecisions`/`formatGateDecisionDiff`, in the
 *  order they're reported. `contextCeiling` renders "—" when absent so an
 *  appear/disappear transition still shows a readable from/to pair rather
 *  than "undefined". */
const DIFF_FIELDS: Array<{
  field: string;
  read: (r: GateDecisionRecord) => string;
}> = [
  { field: "action", read: (r) => r.action },
  // The most consequential diff there is: the same worker on the same class
  // decided by a DIFFERENT rule. Reads through `ruleOf` so an older row shows
  // "—" rather than inventing an absence that looks like a rule change.
  {
    field: "ruleId",
    read: (r) => {
      const st = ruleOf(r);
      return st.state === "named" ? st.ruleId : "—";
    },
  },
  { field: "owned", read: (r) => String(r.owned) },
  { field: "earnedLevel", read: (r) => `L${r.earnedLevel}` },
  { field: "autonomyCeiling", read: (r) => `L${r.autonomyCeiling}` },
  {
    field: "contextCeiling",
    read: (r) =>
      r.contextCeiling !== undefined ? `L${r.contextCeiling}` : "—",
  },
  { field: "effectiveLevel", read: (r) => `L${r.effectiveLevel}` },
  { field: "reason", read: (r) => r.reason },
];

/**
 * Compare two decisions on the same worker × action-class and report what
 * changed — Tier 2 of the "explain trust movement" legibility layer. Pure
 * over two already-persisted records; no new gate logic, no I/O.
 *
 * Field order is oldest→newest-agnostic: callers pass whichever record they
 * consider "newer"/"older" (typically `query()`'s [0] and [1], since it
 * sorts most-recent-first); the diff reports `from` (older) → `to` (newer).
 */
export function diffGateDecisions(
  newer: GateDecisionRecord,
  older: GateDecisionRecord,
): GateDecisionFieldDiff[] {
  const diffs: GateDecisionFieldDiff[] = [];
  for (const { field, read } of DIFF_FIELDS) {
    const from = read(older);
    const to = read(newer);
    if (from !== to) diffs.push({ field, from, to });
  }
  return diffs;
}

/** Render `diffGateDecisions`' output as prose: a header identifying both
 *  decisions being compared, then one line per changed field, or an explicit
 *  "no change" line when nothing differs (e.g. two identical gates in a row —
 *  itself a meaningful, if unexciting, answer). */
export function formatGateDecisionDiff(
  newer: GateDecisionRecord,
  older: GateDecisionRecord,
): string {
  const fmtWhen = (r: GateDecisionRecord) =>
    new Date(r.decidedAt).toISOString();
  const header =
    `Comparing decision seq ${older.seq} (${fmtWhen(older)}) → ` +
    `seq ${newer.seq} (${fmtWhen(newer)}) for ${newer.workerId} on ${newer.classKey}`;
  const diffs = diffGateDecisions(newer, older);
  if (diffs.length === 0) {
    return `${header}\n  No change — identical decision.`;
  }
  const lines = diffs.map((d) => `  ${d.field}: ${d.from} → ${d.to}`);
  return [header, ...lines].join("\n");
}
