/**
 * Shared worker-trust aggregation helpers.
 *
 * Extracted from app/workers/page.tsx so /today's "glance at the team"
 * section can derive the same promotable/ready-to-advance signal instead
 * of re-implementing the classKey parsing rules. The page keeps its own
 * richer vocabulary maps (LEVEL_LABELS, PLAIN_LEVELS, etc.) — those are
 * presentation-only and stay page-local; only the data-shape + pure
 * aggregation functions move here.
 */

export interface BoardRow {
  classKey: string;
  level: number;
  observations: number;
  mean: number;
  /** False = the worker performed this class but does not own it — the live
   *  gate floors it to L0 regardless of accrued evidence (mirrors the CLI's
   *  `workers shadow` "⚠ NOT OWNED" flag). */
  owned: boolean;
}

export interface Divergence {
  classKey: string;
  toolName: string;
  ramp: string;
  gate: string;
  at: number;
  note: string;
}

/** A promote/demote milestone in a worker's trust journey. */
export interface AuditEvent {
  type: "promote" | "demote";
  classKey: string;
  from: number;
  to: number;
  at: number;
  evidence: number;
  reason: string;
  workerId: string;
}

export interface WorkerReport {
  workerId: string;
  name: string;
  autonomyCeiling: number;
  board: BoardRow[];
  events: AuditEvent[];
  compared: number;
  agreed: number;
  divergences: Divergence[];
}

export interface ShadowResponse {
  workers: WorkerReport[];
  runsScanned: number;
  decisionsScanned: number;
  generatedAt?: string;
}

/** The classKey is `domain:reversibility:blastTier`. Reversible actions
 *  bypass the gate unconditionally (they're easily undone), so the
 *  autonomy ceiling never restricts them — "capped" and "ready to
 *  promote" are meaningless there. */
export function isReversible(classKey: string): boolean {
  return classKey.split(":")[1] === "reversible";
}

const DOMAIN_LABELS: Record<string, string> = {
  issue: "filing issues",
  "fs-write": "changing files",
  "fs-read": "reading files",
  "vcs-read": "reading code history",
  "vcs-remote": "pushing to GitHub",
  "vcs-merge": "merging code",
  "vcs-local": "local commits",
  messaging: "sending messages",
  ci: "running tests / CI",
  net: "network requests",
  other: "other actions",
};

export function taskName(classKey: string): string {
  const domain = classKey.split(":")[0] ?? classKey;
  return DOMAIN_LABELS[domain] ?? domain;
}

/** Ready to promote: an OWNED, non-reversible task where the worker earned
 *  a higher level than the ceiling you set — it has proven more than you
 *  allow on work that actually needs a leash. */
export function readyToAdvance(w: WorkerReport): boolean {
  return w.board.some(
    (b) => b.owned && !isReversible(b.classKey) && b.level > w.autonomyCeiling,
  );
}

/** The highest-stakes OWNED, non-reversible task a worker is promotable on
 *  (the one whose ceiling you'd actually raise), or undefined if none. */
export function topPromotable(w: WorkerReport): BoardRow | undefined {
  const promotable = w.board
    .filter((b) => b.owned && !isReversible(b.classKey) && b.level > w.autonomyCeiling)
    .sort((a, b) => b.level - a.level);
  return promotable[0];
}

/** Most recent demotion across a worker's events, or undefined. */
export function lastDemotion(w: WorkerReport): AuditEvent | undefined {
  const demotions = w.events.filter((e) => e.type === "demote");
  if (demotions.length === 0) return undefined;
  return [...demotions].sort((a, b) => b.at - a.at)[0];
}
