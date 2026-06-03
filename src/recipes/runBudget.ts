/**
 * Per-recipe budget — PR2b (tokens) + cost-routing Phase 3 (USD).
 *
 * Built on PR2a's `AgentResult.usage` plumbing. The runner constructs one
 * `RunBudget` per recipe execution; agent steps consult it before dispatch
 * (admission) and reconcile actual consumption after the call returns. On
 * breach the run halts at the *next* admission check (we never retroactively
 * fail a step that succeeded — the user's tokens/dollars are already spent;
 * halting after-the-fact would just confuse the audit trail).
 *
 * Two independent caps, either or both:
 *   - `tokensMax` — cumulative input + output tokens.
 *   - `usdMax`    — cumulative USD, priced from token usage via the Phase 2
 *                   price table (`costUsd`).
 *
 * Subscription drivers (Claude CLI, provider subprocess CLIs) don't surface
 * per-call token counts, and a model with no price-table entry can't be
 * costed. Both cases FAIL OPEN: `RunBudget` records a deduped one-time
 * warning and never blocks. So a USD cap enforces for *measured + priced*
 * (API) drivers and is a no-op-with-notice for everything else — never a
 * silent or a surprise halt on the token-blind default driver. (The opt-in
 * estimate-the-unmeasured path is a planned follow-up; absent it, unmeasured
 * = fail-open, which is the conservative default the design calls for.)
 */

import { type AgentUsage, DEFAULT_MODEL } from "./agentExecutor.js";
import {
  costUsd,
  loadPriceTable,
  type PriceTable,
} from "./pricing/priceTable.js";
import type { BudgetPolicy } from "./schema.js";

/**
 * Drivers that incur real, metered, per-token API billing — the ONLY ones a
 * USD cap is enforced against. Subscription/CLI drivers (subprocess Claude/
 * Gemini) report no usage and never reach the pricing path; `local`
 * (self-hosted Ollama / LM Studio) DOES report usage but costs no real money,
 * so it must not be priced at notional API rates and halted on spend that
 * never happened. Anything not in this set fails open with a one-time notice.
 */
const BILLABLE_DRIVERS = new Set(["anthropic", "openai", "grok"]);

export interface BudgetAdmission {
  /** True = step may proceed. False = budget exhausted. */
  admitted: boolean;
  /** When `admitted: false`, a one-sentence reason fit for haltReason. */
  reason?: string;
}

export interface BudgetTotals {
  inputTokens: number;
  outputTokens: number;
  total: number;
  /** Remaining tokens before breach. Undefined when no token limit is set. */
  remaining?: number;
  /** Cumulative measured USD. Undefined when no USD limit is set. */
  usd?: number;
  /** Remaining USD before breach. Undefined when no USD limit is set. */
  usdRemaining?: number;
  /** True once total tokens >= tokensMax (false when no token limit). */
  breached: boolean;
  /** True once measured usd >= usdMax (false when no USD limit). */
  usdBreached: boolean;
  /** Whether the configured policy halts on breach (vs warn). */
  haltOnBreach: boolean;
}

export class RunBudget {
  private readonly tokensMax?: number;
  private readonly usdMax?: number;
  private readonly haltOnBreach: boolean;
  private readonly priceTable?: PriceTable;
  private inputTokens = 0;
  private outputTokens = 0;
  private usdSpent = 0;
  /** Dedup keys for one-time warnings (unmeasured driver, breach, etc.). */
  private readonly warnedKeys = new Set<string>();
  /** Free-form warnings surfaced via the run log. */
  private readonly warningList: string[] = [];

  /**
   * @param policy   recipe budget block.
   * @param priceTable  optional injected table (tests); otherwise loaded once
   *                    here when a USD cap is set (file/env override aware).
   */
  constructor(policy?: BudgetPolicy, priceTable?: PriceTable) {
    this.tokensMax = policy?.tokensMax;
    this.usdMax = policy?.usdMax;
    this.haltOnBreach = (policy?.onBreach ?? "halt") === "halt";
    if (this.usdMax !== undefined) {
      this.priceTable = priceTable ?? loadPriceTable();
    }
  }

  /** True when neither cap is configured — reconcile/admit are no-ops. */
  private get hasBudget(): boolean {
    return this.tokensMax !== undefined || this.usdMax !== undefined;
  }

  /** Cheap admission check before dispatching an agent step. */
  admit(): BudgetAdmission {
    // warn-mode never blocks; the breach warning was emitted at reconcile.
    if (!this.haltOnBreach) return { admitted: true };
    if (this.tokenBreached()) {
      return {
        admitted: false,
        reason: `Run exceeded its token budget — budget_exceeded: total=${this.totalTokens()} >= tokensMax=${this.tokensMax}.`,
      };
    }
    if (this.usdMaxBreached()) {
      return {
        admitted: false,
        reason: `Run exceeded its USD budget — budget_exceeded: usd=$${this.usdSpent.toFixed(4)} >= usdMax=$${this.usdMax}.`,
      };
    }
    return { admitted: true };
  }

  /**
   * Record the actual usage reported by an agent call. `usage` is undefined
   * when the driver doesn't surface token counts — record the driver once and
   * continue (fail-open). `model` is the resolved model (from `servedBy`) used
   * to price USD; an unpriced model fails open with a one-time notice.
   */
  reconcile(
    driver: string,
    usage: AgentUsage | undefined,
    model?: string,
  ): void {
    if (!this.hasBudget) return;
    if (!usage) {
      this.pushOnce(
        `unmeasured:${driver}`,
        `Driver "${driver}" does not report token usage — budget enforcement skipped for its calls. Set recipe.budget.onBreach="warn" or move to an API driver to fix.`,
      );
      return;
    }

    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;

    if (this.usdMax !== undefined) {
      if (!BILLABLE_DRIVERS.has(driver)) {
        // Not a metered-API driver (local / subscription) — a USD cap here
        // would be notional, not real money out. Fail open with a notice.
        this.pushOnce(
          `notbilled:${driver}`,
          `Driver "${driver}" does not incur metered API cost — usdMax is not enforced for its calls.`,
        );
      } else {
        const cost = costUsd(model ?? "", usage, this.priceTable);
        // `cost === undefined` (unpriced model) OR a non-finite cost (defends
        // against a malformed price entry) → fail open, never poison usdSpent.
        if (cost === undefined || !Number.isFinite(cost)) {
          this.pushOnce(
            `unpriced:${model ?? "(no model)"}`,
            `Model "${model ?? "(unspecified)"}" is not in the price table — USD budget enforcement skipped for its calls. Add it to ~/.patchwork/prices.json or set the agent step's model.`,
          );
        } else {
          this.usdSpent += cost;
        }
      }
    }

    // warn-mode: emit a single in-band notice the first time we cross a cap.
    if (!this.haltOnBreach) {
      if (this.tokenBreached()) {
        this.pushOnce(
          "warn-token-breach",
          `Token budget exceeded (total=${this.totalTokens()}, tokensMax=${this.tokensMax}) but onBreach="warn" — continuing.`,
        );
      }
      if (this.usdMaxBreached()) {
        this.pushOnce(
          "warn-usd-breach",
          `USD budget exceeded (usd=$${this.usdSpent.toFixed(4)}, usdMax=$${this.usdMax}) but onBreach="warn" — continuing.`,
        );
      }
    }
  }

  /** Snapshot of current totals + breach state. */
  totals(): BudgetTotals {
    const total = this.totalTokens();
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      total,
      ...(this.tokensMax !== undefined && {
        remaining: Math.max(0, this.tokensMax - total),
      }),
      ...(this.usdMax !== undefined && {
        usd: this.usdSpent,
        usdRemaining: Math.max(0, this.usdMax - this.usdSpent),
      }),
      breached: this.tokenBreached(),
      usdBreached: this.usdMaxBreached(),
      haltOnBreach: this.haltOnBreach,
    };
  }

  /** Warnings collected so the runner can surface them in the run log. */
  warnings(): string[] {
    return [...this.warningList];
  }

  /**
   * USD remaining before the cap, or undefined when no USD cap is set.
   * Cost-aware routing (Phase 4) uses this to decide when to downshift.
   */
  remainingUsd(): number | undefined {
    if (this.usdMax === undefined) return undefined;
    return Math.max(0, this.usdMax - this.usdSpent);
  }

  /**
   * Pre-dispatch USD estimate for a prospective (driver, model) call, or
   * undefined when it would NOT be USD-enforced: no USD cap, a non-billable
   * driver (local / subscription), or an unpriced model. Mirrors exactly the
   * enforcement rule in `reconcile`, so a candidate the router treats as
   * "free" is precisely one `reconcile` would not charge.
   */
  quoteUsd(
    driver: string | undefined,
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
  ): number | undefined {
    if (this.usdMax === undefined) return undefined;
    // Mirror executeAgent/reconcile resolution so a candidate the router calls
    // "free" is EXACTLY one reconcile would not charge:
    //   - "api"/"claude" select the billable Anthropic path (→ "anthropic").
    //   - undefined optimistically assumes auto-detect lands on a metered API
    //     driver (usually anthropic); if it actually resolves to a subscription
    //     driver the call is free and the cap simply isn't enforced there.
    const resolvedDriver =
      driver === "api" || driver === "claude" ? "anthropic" : driver;
    if (resolvedDriver !== undefined && !BILLABLE_DRIVERS.has(resolvedDriver)) {
      return undefined;
    }
    // The anthropic path bills DEFAULT_MODEL when the step omits `model`.
    // (Provider drivers default internally to a model unknowable pre-dispatch,
    // so an omitted model there stays unpriced → not routed on.)
    const onAnthropicPath =
      resolvedDriver === "anthropic" || resolvedDriver === undefined;
    const resolvedModel =
      model ?? (onAnthropicPath ? DEFAULT_MODEL : undefined);
    if (!resolvedModel) return undefined;
    const cost = costUsd(
      resolvedModel,
      { inputTokens, outputTokens },
      this.priceTable,
    );
    return cost !== undefined && Number.isFinite(cost) ? cost : undefined;
  }

  private pushOnce(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.warningList.push(msg);
  }

  private totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  private tokenBreached(): boolean {
    return this.tokensMax !== undefined && this.totalTokens() >= this.tokensMax;
  }

  private usdMaxBreached(): boolean {
    return this.usdMax !== undefined && this.usdSpent >= this.usdMax;
  }
}
