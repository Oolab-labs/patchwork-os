/**
 * Per-recipe token budget — PR2b.
 *
 * Built on PR2a's `AgentResult.usage` plumbing. The runner constructs
 * one `RunBudget` per recipe execution; agent steps consult it before
 * dispatch (admission) and reconcile actual consumption after the call
 * returns. On breach the run halts at the *next* admission check (we
 * never retroactively fail a step that succeeded — the user's tokens
 * are already spent, halting after-the-fact would just confuse the
 * audit trail).
 *
 * Subscription drivers (Claude CLI, provider subprocess CLIs) don't
 * surface per-call token counts. `RunBudget` tracks which drivers were
 * unmeasured and exposes a deduped warnings list — fail-open with a
 * single notice per driver per run, never block.
 *
 * Scope (PR2b only):
 *   - cumulative token enforcement (input + output)
 *   - halt-on-breach OR warn-on-breach via `BudgetPolicy.onBreach`
 *   - subscription-driver fail-open with warning
 *
 * Out of scope (future):
 *   - per-step caps (extend `BudgetPolicy` or add `AgentStep.tokensMax`)
 *   - `usdMax` (needs a price table; subscription drivers complicate)
 *   - `wallClockMs` (orthogonal to tokens, separate accounting)
 */

import type { AgentUsage } from "./agentExecutor.js";
import type { BudgetPolicy } from "./schema.js";

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
  /** Remaining tokens before breach. Undefined when no limit is set. */
  remaining?: number;
  /** True once total >= tokensMax. */
  breached: boolean;
  /** Whether the configured policy halts on breach (vs warn). */
  haltOnBreach: boolean;
}

export class RunBudget {
  private readonly tokensMax?: number;
  private readonly haltOnBreach: boolean;
  private inputTokens = 0;
  private outputTokens = 0;
  /** Drivers that returned `usage: undefined` during this run, deduped. */
  private readonly unmeasuredDrivers = new Set<string>();
  /** Free-form warnings surfaced via the run log. */
  private readonly warningList: string[] = [];

  constructor(policy?: BudgetPolicy) {
    this.tokensMax = policy?.tokensMax;
    this.haltOnBreach = (policy?.onBreach ?? "halt") === "halt";
  }

  /** Cheap admission check before dispatching an agent step. */
  admit(): BudgetAdmission {
    if (this.tokensMax === undefined) return { admitted: true };
    if (this.breached()) {
      if (!this.haltOnBreach) {
        // warn-mode: never block, just keep going. The warning was
        // already emitted on the post-call reconcile that breached.
        return { admitted: true };
      }
      return {
        admitted: false,
        reason: `Run exceeded its token budget — budget_exceeded: total=${this.totalTokens()} > tokensMax=${this.tokensMax}.`,
      };
    }
    return { admitted: true };
  }

  /**
   * Record the actual usage reported by an agent call. `usage` may be
   * undefined when the driver doesn't surface token counts — we record
   * the driver name once per run and continue (fail-open).
   */
  reconcile(driver: string, usage: AgentUsage | undefined): void {
    if (this.tokensMax === undefined) return;
    if (!usage) {
      if (!this.unmeasuredDrivers.has(driver)) {
        this.unmeasuredDrivers.add(driver);
        this.warningList.push(
          `Driver "${driver}" does not report token usage — budget enforcement skipped for its calls. Set recipe.budget.onBreach="warn" or move to an API driver to fix.`,
        );
      }
      return;
    }
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    if (this.breached() && !this.haltOnBreach) {
      // warn-mode: emit a single in-band warning the first time we
      // cross the line. Subsequent steps continue running.
      const breachKey = "warn-breach-emitted";
      if (!this.unmeasuredDrivers.has(breachKey)) {
        this.unmeasuredDrivers.add(breachKey);
        this.warningList.push(
          `Token budget exceeded (total=${this.totalTokens()}, tokensMax=${this.tokensMax}) but onBreach="warn" — continuing.`,
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
      breached: this.breached(),
      haltOnBreach: this.haltOnBreach,
    };
  }

  /** Warnings collected so the runner can surface them in the run log. */
  warnings(): string[] {
    return [...this.warningList];
  }

  private totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  private breached(): boolean {
    return this.tokensMax !== undefined && this.totalTokens() >= this.tokensMax;
  }
}
