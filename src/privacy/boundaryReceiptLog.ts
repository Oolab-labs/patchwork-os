/**
 * Information-boundary receipts (ADR-0021 Phase 3).
 *
 * > Every boundary decision produces a record, in the same shape and store as
 * > gate decisions: what was declared, where it was going, what was removed,
 * > what was retained, why.
 *
 * Patchwork's standing claim is that every consequential decision leaves a
 * receipt. The autonomy gate extends that to *what the AI did*; this extends it
 * to *what the AI was told* — which is the half nobody could previously audit.
 *
 * ## The one thing this file must never do
 *
 * **It must never contain the payload.** A receipt records that a decision was
 * made about data with a given classification; writing the prompt itself would
 * turn the privacy audit log into the largest unclassified copy of exactly the
 * material the boundary exists to protect, sitting in plain JSONL. Only
 * declared metadata is stored: classification, category NAMES, destination id,
 * decision, reason. There is no field for the text, deliberately, so a future
 * caller cannot pass one by accident.
 *
 * ## Fail-soft, always
 *
 * A receipt that cannot be written must never block or alter a decision. The
 * boundary already refuses correctly without any sink attached (pinned by a
 * test in agentBoundary.test.ts); this store is observability, not enforcement.
 * Every write path here swallows its own errors for that reason.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { BoundaryDecision, Classification } from "./dataPolicy.js";

/**
 * Writer-stamped record level for this ledger.
 *
 * `rv: N` asserts: for every field registered as known from level <= N, that
 * field is present, or its registered not-applicable condition held. Same
 * protocol the gate ledger adopted in #1519, and adopted here for the same
 * reason — a reader must be able to tell "no claim was made" from "a claim was
 * made and honoured" from "a claim was made and broken".
 *
 * ## Field registry
 *
 * - `correlationId` (level 1) — **never legitimately absent.** Every receipt is
 *   written from inside a run: the flat write sites are inside `runYamlRecipe`,
 *   and all three chained dep-builders dispatch into `runChainedRecipe`, which
 *   always computes a `runTaskId`. So there is no "decided outside any run"
 *   state for this ledger to represent. Its absence at `rv >= 1` is a WRITER
 *   DEFECT, not a state.
 *
 * ## What absence of `rv` means, and why it is never repaired
 *
 * A row with no `rv` pre-dates this protocol. That is the sentinel, and it is
 * unrepairable by construction: there is no backfill, and `parsed.rv ?? 0` on
 * read would be a backfill performed invisibly on every load. Never default it.
 *
 * Do NOT read "no `rv`" as "old". A stale bridge writing un-`rv`'d rows today
 * is indistinguishable from a row written months ago — the mistake already
 * found shipped elsewhere and fixed as #1515.
 */
export const BOUNDARY_RECORD_VERSION = 1;

/** Clip so a runaway reason cannot bloat the audit log. */
const MAX_REASON = 500;
const DEFAULT_MEMORY_CAP = 500;

export interface BoundaryReceipt {
  seq: number;
  at: number;
  /**
   * Writer-stamped record level — see `BOUNDARY_RECORD_VERSION`. Optional on
   * the TYPE because rows written before this protocol have none, and that
   * absence is the sentinel. Always present on rows this constructor writes.
   */
  rv?: number;
  /**
   * The run this decision belongs to — the run log's `taskId`, never `seq`.
   *
   * `seq` is a per-INSTANCE counter over a file eight construction sites write,
   * so it collides across concurrent bridges (255 distinct over 272 rows when
   * measured on the gate ledger). A join key that collides is not a join key.
   *
   * Registered as never legitimately absent at `rv >= 1`.
   */
  correlationId?: string;
  decision: BoundaryDecision;
  /** What the step DECLARED it was carrying. */
  classification: Classification;
  /** Category names only — never their contents. */
  categories?: string[];
  /** Where it was going. */
  destinationId: string;
  destinationType: "local" | "remote";
  /** Which categories the decision required be removed. */
  redactCategories?: string[];
  reason: string;
  /**
   * Which recipe produced this (#1474).
   *
   * A sibling `stepId` was declared here and supplied by nothing — the exact
   * field, for the exact reason, that #1469 removed from `ShadowRow`. Removed
   * rather than wired: the decision point has no step id in scope, so a
   * declared-but-empty field only tells a reader that step-level attribution
   * exists when it does not.
   */
  recipeName?: string;
  /** Short workspace id — a tag for attribution, never a filter. */
  workspaceId?: string;
}

export interface RecordBoundaryReceiptInput {
  /**
   * The run this decision belongs to (`taskId`). Deliberately NOT `rv` — the
   * record level is the WRITER's claim about its own completeness, so a caller
   * that could set it could forge it.
   */
  correlationId?: string;
  decision: BoundaryDecision;
  classification: Classification;
  categories?: string[];
  destinationId: string;
  destinationType: "local" | "remote";
  redactCategories?: string[];
  reason: string;
  recipeName?: string;
  workspaceId?: string;
}

export interface BoundaryReceiptLogOptions {
  dir: string;
  memoryCap?: number;
  now?: () => number;
  logger?: { warn?: (msg: string) => void };
}

export class BoundaryReceiptLog {
  private receipts: BoundaryReceipt[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private readonly now: () => number;

  constructor(private readonly opts: BoundaryReceiptLogOptions) {
    this.file = path.join(opts.dir, "boundary_receipts.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.now = opts.now ?? Date.now;
    try {
      // 0o700 like the gate log: these name destinations and classifications,
      // which is a map of what this machine considers sensitive.
      mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      opts.logger?.warn?.(
        `[boundary-receipts] could not create ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.loadExisting();
  }

  private loadExisting(): void {
    try {
      const text = readFileSync(this.file, "utf-8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t) as BoundaryReceipt;
          if (typeof r.seq === "number") {
            this.receipts.push(r);
            if (r.seq > this.seq) this.seq = r.seq;
          }
        } catch {
          // one malformed line must not make the whole log unreadable
        }
      }
      this.trim();
    } catch {
      // no file yet — normal on first run
    }
  }

  private trim(): void {
    if (this.receipts.length > this.memoryCap) {
      this.receipts = this.receipts.slice(-this.memoryCap);
    }
  }

  /**
   * Record one boundary decision.
   *
   * Returns the stored receipt. Never throws: a failure to persist is logged
   * and swallowed, because this is observability and the decision it describes
   * has already been made and enforced.
   */
  record(input: RecordBoundaryReceiptInput): BoundaryReceipt {
    const receipt: BoundaryReceipt = {
      seq: ++this.seq,
      at: this.now(),
      rv: BOUNDARY_RECORD_VERSION,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      decision: input.decision,
      classification: input.classification,
      destinationId: input.destinationId,
      destinationType: input.destinationType,
      reason: input.reason.slice(0, MAX_REASON),
      ...(input.categories?.length ? { categories: input.categories } : {}),
      ...(input.redactCategories?.length
        ? { redactCategories: input.redactCategories }
        : {}),
      ...(input.recipeName ? { recipeName: input.recipeName } : {}),
      // Both types have declared `workspaceId` since #1455 and the caller has
      // been passing it since; this constructor never copied it, so the field
      // could not appear on a receipt from any bridge, in any working
      // directory. That is why 22 of 40 shadow rows carried a workspace tag
      // while 0 of 4 receipts did — two independent bugs stacked on one field,
      // and the shadow ledger's partial success hid the receipt ledger's total
      // failure.
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    };
    this.receipts.push(receipt);
    this.trim();
    try {
      appendFileSync(this.file, `${JSON.stringify(receipt)}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[boundary-receipts] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return receipt;
  }

  /** Most recent first. */
  recent(limit = 50): BoundaryReceipt[] {
    return this.receipts.slice(-limit).reverse();
  }

  /** Counts per decision — the shape a dashboard or CLI summary wants. */
  summary(): Record<BoundaryDecision, number> {
    const out = {
      ALLOW: 0,
      ALLOW_REDACTED: 0,
      LOCAL_ONLY: 0,
      REQUIRE_APPROVAL: 0,
      DENY: 0,
    } as Record<BoundaryDecision, number>;
    for (const r of this.receipts) out[r.decision]++;
    return out;
  }
}
