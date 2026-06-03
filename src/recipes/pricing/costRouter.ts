/**
 * Cost-aware model routing — cost-routing Phase 4 (pure selection).
 *
 * Opt-in, author-controlled "gearbox" on top of the `usdMax` brake (Phase 3):
 * a per-step `downshift` list lets a recipe drop to a cheaper model as the USD
 * budget tightens, instead of either blowing the cap or halting outright. The
 * recipe author asserts each fallback is "good enough" for the step — the
 * engine does NOT reason about model quality, only affordability.
 *
 * This module is the pure decision: given the preferred (driver, model), the
 * author's ordered downshift candidates, and a quote() that estimates each
 * candidate's USD cost, pick the most-preferred candidate that still fits the
 * remaining budget. It loads nothing and has no side effects — the runner
 * supplies remainingUsd + quote from RunBudget.
 *
 * Absent / empty `downshift` ⇒ returns `preferred` unchanged (byte-identical
 * to no routing). Routing only runs when a USD cap is set (the runner passes
 * remainingUsd only then).
 */

export interface RouteCandidate {
  driver?: string;
  model?: string;
}

export interface RouteContext {
  /** USD left before `budget.usdMax`. The router runs only when a cap is set. */
  remainingUsd: number;
  /**
   * Pre-dispatch USD estimate for a prospective (driver, model) call, or
   * `undefined` when that call is NOT USD-enforced — a non-billable driver
   * (local / subscription) or an unpriced model. An unenforced candidate is
   * treated as always affordable (it costs nothing against the cap), so it is
   * a valid "free" downshift target.
   */
  quote: (
    driver: string | undefined,
    model: string | undefined,
  ) => number | undefined;
}

/**
 * Pick the most-preferred candidate whose estimated cost fits `remainingUsd`.
 * Candidates are tried in order `[preferred, ...downshift]`; a downshift entry
 * inherits the preferred driver/model for any field it omits. If none fit, the
 * last (cheapest listed) is returned and the admit()/reconcile() gate decides
 * whether to halt — downshift slows the spend rate, it never overrides a breach.
 */
export function costRouter(
  preferred: RouteCandidate,
  downshift: RouteCandidate[] | undefined,
  ctx: RouteContext,
): RouteCandidate {
  if (!downshift || downshift.length === 0) return preferred;

  const candidates: RouteCandidate[] = [preferred, ...downshift].map((c) => ({
    driver: c.driver ?? preferred.driver,
    model: c.model ?? preferred.model,
  }));

  for (const cand of candidates) {
    const q = ctx.quote(cand.driver, cand.model);
    // undefined quote = unenforced (free / unpriced) → always affordable.
    if (q === undefined || q <= ctx.remainingUsd) return cand;
  }
  // None fit — fall back to the cheapest listed; the budget gate halts if even
  // that exceeds the cap on the next admission check.
  return candidates[candidates.length - 1] ?? preferred;
}
