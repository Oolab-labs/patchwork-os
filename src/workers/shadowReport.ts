import type { GraduationConfig } from "./graduation.js";
import {
  type DecisionRecord,
  type RunRecord,
  WorkerShadowObserver,
  type WorkerShadowReport,
} from "./shadowObserver.js";
import type { WorkerManifest } from "./worker.js";

/**
 * Build the shadow report by feeding runs + decisions into the observer in
 * timestamp order, so each ramp-vs-gate comparison sees the dial as it stood AT
 * that moment (not the final state). Pure — the I/O entry (runWorkerShadow)
 * supplies the records read from the real logs.
 */
export function buildShadowReport(
  workers: WorkerManifest[],
  runs: RunRecord[],
  decisions: DecisionRecord[],
  cfg?: GraduationConfig,
): WorkerShadowReport[] {
  const obs = new WorkerShadowObserver(workers, { cfg });
  const merged: Array<{ at: number; run?: RunRecord; dec?: DecisionRecord }> = [
    ...runs.map((r) => ({ at: r.at, run: r })),
    ...decisions.map((d) => ({ at: d.at, dec: d })),
  ].sort((a, b) => a.at - b.at);
  for (const e of merged) {
    if (e.run) obs.ingestRun(e.run);
    else if (e.dec) obs.ingestDecision(e.dec);
  }
  return obs.report();
}

export function formatShadowReport(reports: WorkerShadowReport[]): string {
  const lines: string[] = [
    "Worker trust dial — SHADOW (read-only; no live gate change)",
    "",
  ];
  for (const r of reports) {
    lines.push(
      `▸ ${r.name} [${r.workerId}]  ·  autonomy ceiling L${r.autonomyCeiling}`,
    );
    if (r.board.length === 0) {
      lines.push(
        "    (no attributed activity yet — dial fills as the worker runs)",
      );
    } else {
      for (const b of r.board) {
        const capped =
          b.level > r.autonomyCeiling
            ? `  → operating L${r.autonomyCeiling} (ceiling)`
            : "";
        // L3: a class the worker performs but doesn't own is floored to L0 by
        // the gate regardless of the evidence shown here — flag it so the dial
        // isn't read as earned autonomy the gate will honour.
        const notOwned = b.owned ? "" : "  ⚠ NOT OWNED — gate floors to L0";
        lines.push(
          `    ${b.classKey.padEnd(36)} earned L${b.level}${capped}  ·  ${b.observations} obs  ·  ${(b.mean * 100).toFixed(0)}% mean${notOwned}`,
        );
      }
    }
    if (r.compared > 0) {
      lines.push(
        `    ramp vs gate: ${r.agreed}/${r.compared} agree · ${r.divergences.length} divergence(s)`,
      );
      for (const d of r.divergences.slice(0, 5)) {
        lines.push(`      ⚠ ${d.toolName} — ${d.note}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
