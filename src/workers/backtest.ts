import { categoriseHaltReason } from "../recipes/haltCategory.js";
import { classifyActionClass } from "./actionClass.js";
import {
  DEFAULT_GRADUATION_CONFIG,
  type GraduationConfig,
} from "./graduation.js";
import { recommend } from "./shadowGate.js";
import {
  DEFAULT_DURABILITY_WINDOW_MS,
  isDurableSuccess,
  type RunRecord,
} from "./shadowObserver.js";
import { ownsAction, priorFor, type WorkerManifest } from "./worker.js";
import { WorkerLevelStore } from "./workerLevelStore.js";

/**
 * Backtest-as-DIVERGENCE (cold-start calibration; see
 * docs/worker-autonomy-policy-gate.md §3c).
 *
 * Replays a worker's HISTORICAL run log and, at each risky owned action, asks:
 * what would the trust ramp have decided AS OF THAT MOMENT (using only the
 * evidence accrued so far — no lookahead), and how does that compare to what
 * actually happened? This is deliberately NOT a "success rate" — replaying past
 * outcomes scores agreement with what already happened, a censored sample. The
 * honest, demoable metric is DIVERGENCE:
 *
 *   - false-allow: the ramp would have AUTO-RUN an action that turned out BAD.
 *     The dangerous miscalibration — over-trust. This is the number that matters.
 *   - false-gate: the ramp would have GATED an action that turned out GOOD.
 *     The cost of caution — over-gating, not unsafe.
 *
 * "Agreement" = ramp-bypass on a good outcome OR ramp-queue on a bad outcome.
 * Only risky (non-reversible) OWNED actions are scored — reversible always
 * bypasses and unowned always queues, so neither is informative.
 */

export type DivergenceKind = "false-allow" | "false-gate";

export interface BacktestDivergence {
  classKey: string;
  tool: string;
  at: number;
  ramp: "bypass" | "queue";
  outcome: "good" | "bad";
  kind: DivergenceKind;
  /** Earned level the ramp was operating at when it made the call. */
  effectiveLevel: number;
}

export interface BacktestReport {
  workerId: string;
  /** risky owned actions scored */
  considered: number;
  agreed: number;
  /** ramp would auto-run a BAD action (over-trust) — the dangerous miscalibration. */
  falseAllow: number;
  /** ramp would gate a GOOD action (over-caution) — the cost, not unsafe. */
  falseGate: number;
  /** agreed / considered (0 when nothing scored). */
  agreementRate: number;
  divergences: BacktestDivergence[];
}

export interface BacktestOpts {
  cfg?: GraduationConfig;
  /** Wall-clock for durable-outcome labelling. Defaults to past-all-runs so the
   *  whole history is treated as durable (a backtest looks at settled outcomes). */
  now?: number;
  durabilityWindowMs?: number;
}

/**
 * Pure backtest of one worker over a set of runs. Folds outcomes chronologically
 * (durable-outcome aware), taking the ramp's recommendation BEFORE folding each
 * step so every decision uses only prior evidence.
 */
export function backtestWorker(
  worker: WorkerManifest,
  runs: RunRecord[],
  opts: BacktestOpts = {},
): BacktestReport {
  const store = new WorkerLevelStore();
  const prior = priorFor(worker);
  const cfg = opts.cfg ?? DEFAULT_GRADUATION_CONFIG;
  const windowMs = opts.durabilityWindowMs ?? DEFAULT_DURABILITY_WINDOW_MS;
  const sorted = [...runs]
    .filter((r) => r.recipeName === worker.recipe)
    .sort((a, b) => a.at - b.at);
  // Default `now` past every run so settled history counts as durable.
  const last = sorted.at(-1);
  const now = opts.now ?? (last ? last.at + windowMs + 1 : 0);

  const divergences: BacktestDivergence[] = [];
  let considered = 0;
  let agreed = 0;
  let falseAllow = 0;
  let falseGate = 0;

  for (const run of sorted) {
    for (const step of run.steps) {
      if (!step.tool || step.status === "skipped") continue;
      // Human reject/expire/cancel is a control decision, not worker evidence.
      if (
        step.status === "error" &&
        categoriseHaltReason(step.haltReason) === "approval_rejected"
      )
        continue;

      const ac = classifyActionClass(step.tool);
      // Score only risky OWNED actions — the calibration-relevant ones.
      if (ac.reversibility !== "reversible" && ownsAction(worker, ac)) {
        const rec = recommend(worker, step.tool, undefined, store); // as-of decision
        const outcomeGood = step.status === "ok";
        const rampBypass = rec.decision === "bypass";
        considered++;
        if (rampBypass === outcomeGood) {
          agreed++;
        } else {
          const kind: DivergenceKind = rampBypass
            ? "false-allow"
            : "false-gate";
          if (rampBypass) falseAllow++;
          else falseGate++;
          divergences.push({
            classKey: ac.key,
            tool: step.tool,
            at: run.at,
            ramp: rec.decision,
            outcome: outcomeGood ? "good" : "bad",
            kind,
            effectiveLevel: rec.effectiveLevel,
          });
        }
      }

      // Fold the outcome (durable-outcome aware) so the ramp evolves over the
      // replay — same labelling as the live dial/gate.
      if (
        step.status === "ok" &&
        !isDurableSuccess(ac.reversibility, run.at, now, windowMs)
      )
        continue; // recent non-reversible success — not yet durable
      store.apply(
        worker.id,
        { toolName: step.tool, good: step.status === "ok", at: run.at },
        { prior, cfg },
      );
    }
  }

  return {
    workerId: worker.id,
    considered,
    agreed,
    falseAllow,
    falseGate,
    agreementRate: considered ? agreed / considered : 0,
    divergences,
  };
}

export function formatBacktestReport(r: BacktestReport): string {
  if (r.considered === 0) {
    return `▸ ${r.workerId}: no risky owned actions in the replay window — nothing to calibrate.\n`;
  }
  const pct = (r.agreementRate * 100).toFixed(0);
  const lines: string[] = [
    `▸ ${r.workerId} — backtest over ${r.considered} risky owned action(s)`,
    `    agreed with the outcome: ${r.agreed}/${r.considered} (${pct}%)`,
    `    false-allow: ${r.falseAllow}  (ramp would AUTO-RUN a bad action — over-trust)`,
    `    false-gate:  ${r.falseGate}  (ramp would gate a good action — cost of caution)`,
  ];
  const fa = r.divergences.filter((d) => d.kind === "false-allow").slice(0, 5);
  if (fa.length) {
    lines.push("    ⚠ false-allow divergences (the ones to look at):");
    for (const d of fa)
      lines.push(
        `      ${d.tool} [${d.classKey}] at L${d.effectiveLevel} → ramp bypass, outcome BAD`,
      );
  }
  return `${lines.join("\n")}\n`;
}
