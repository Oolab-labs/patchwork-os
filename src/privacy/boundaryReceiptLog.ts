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

/** Clip so a runaway reason cannot bloat the audit log. */
const MAX_REASON = 500;
const DEFAULT_MEMORY_CAP = 500;

export interface BoundaryReceipt {
  seq: number;
  at: number;
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
  /** Recipe/step context when the caller knows it. */
  recipeName?: string;
  stepId?: string;
}

export interface RecordBoundaryReceiptInput {
  decision: BoundaryDecision;
  classification: Classification;
  categories?: string[];
  destinationId: string;
  destinationType: "local" | "remote";
  redactCategories?: string[];
  reason: string;
  recipeName?: string;
  stepId?: string;
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
      ...(input.stepId ? { stepId: input.stepId } : {}),
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
