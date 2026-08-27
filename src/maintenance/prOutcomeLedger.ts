/**
 * PR outcome ledger, phase 1 — record raw events, derive nothing.
 *
 * This exists early for one reason: outcome history accrues only with
 * wall-clock time. Every other item on the maintenance roadmap can be built
 * whenever; this one loses evidence for each day it does not exist, and that
 * evidence cannot be backfilled. A pull request that was opened small, grew
 * under review, and was reverted a week later leaves no trace of that shape
 * once it is closed — the API returns only its final state.
 *
 * ## Observations, not records
 *
 * Each row is what the API said about one pull request AT ONE MOMENT. Collect
 * regularly and the shape falls out: diff size at open versus at merge, how
 * long it sat, whether it grew. Collect once, retroactively, and you get final
 * states only — which is honest, and is why the summary reports how many pull
 * requests have more than one observation rather than implying every row is a
 * trajectory.
 *
 * ## No score
 *
 * Deliberately no scalar. A single trust number computed now would fix its
 * weighting before there is any evidence to weigh it against, and every later
 * question ("did worker-authored PRs need more human edits?") would have to be
 * answered from a number that already threw the answer away. Raw fields;
 * scores derived later, when there is something to derive them from.
 *
 * ## Absence stays absence
 *
 * `authorIsWorker` is OMITTED when no worker roster is supplied, never
 * defaulted to false. "We do not know whether a worker opened this" and "a
 * human opened this" are different facts, and collapsing them would silently
 * mark every historical pull request as human-authored — the same
 * never-backfill rule `workerGateDecisionLog` states in its own header.
 *
 * Rows carry `rv: 1` so a later schema change is distinguishable from an old
 * row, for the same reason the gate ledger does.
 */

/** Schema version. A reader must be able to tell an old row from a new one. */
export const PR_OBSERVATION_RV = 1;

export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** One pull request as the API described it at one moment. */
export interface PrObservation {
  rv: number;
  /** `owner/name`. */
  repo: string;
  number: number;
  /** When THIS observation was taken — not when anything happened to the PR. */
  observedAt: string;
  state: PrState;
  authorLogin: string;
  /** True when the API says the author is a bot. Absent when unknown. */
  authorIsBot?: boolean;
  /**
   * Whether a Patchwork worker opened this. OMITTED when no roster was
   * supplied — never defaulted, see the header.
   */
  authorIsWorker?: boolean;
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Lets a later pass find a revert without re-querying every pull request. */
  mergeCommitSha?: string;
}

/** The shape the API returns. Everything optional: it varies by query. */
export interface RawGhPr {
  number?: unknown;
  state?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  closedAt?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
  author?: { login?: unknown; is_bot?: unknown } | null;
  mergeCommit?: { oid?: unknown } | null;
}

export interface ToObservationOptions {
  repo: string;
  observedAt: string;
  /**
   * Logins known to be Patchwork workers. When undefined, `authorIsWorker` is
   * omitted entirely rather than guessed.
   */
  workerLogins?: ReadonlySet<string>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Convert one API row into an observation, or null when it lacks the fields
 * that make it identifiable. A row that cannot be keyed is dropped rather than
 * written with a placeholder number: an unidentifiable observation is not
 * evidence of anything.
 */
export function toObservation(
  raw: RawGhPr,
  opts: ToObservationOptions,
): PrObservation | null {
  const number = num(raw.number);
  const stateRaw = str(raw.state)?.toUpperCase();
  const createdAt = str(raw.createdAt);
  const login = str(raw.author?.login);
  if (number === null || createdAt === null || login === null) return null;
  if (stateRaw !== "OPEN" && stateRaw !== "MERGED" && stateRaw !== "CLOSED") {
    return null;
  }
  const mergedAt = str(raw.mergedAt);
  const closedAt = str(raw.closedAt);
  const sha = str(raw.mergeCommit?.oid);
  return {
    rv: PR_OBSERVATION_RV,
    repo: opts.repo,
    number,
    observedAt: opts.observedAt,
    state: stateRaw,
    authorLogin: login,
    ...(typeof raw.author?.is_bot === "boolean" && {
      authorIsBot: raw.author.is_bot,
    }),
    // Omitted, not defaulted, when no roster was supplied.
    ...(opts.workerLogins !== undefined && {
      authorIsWorker: opts.workerLogins.has(login),
    }),
    createdAt,
    ...(mergedAt !== null && { mergedAt }),
    ...(closedAt !== null && { closedAt }),
    additions: num(raw.additions) ?? 0,
    deletions: num(raw.deletions) ?? 0,
    changedFiles: num(raw.changedFiles) ?? 0,
    ...(sha !== null && { mergeCommitSha: sha }),
  };
}

/** Fields that make an observation MEANINGFULLY different from the last one. */
function fingerprint(o: PrObservation): string {
  return [
    o.state,
    o.additions,
    o.deletions,
    o.changedFiles,
    o.mergedAt ?? "",
    o.closedAt ?? "",
  ].join(" ");
}

export interface DedupeResult {
  /** Observations worth appending. */
  toAppend: PrObservation[];
  /** How many were identical to what the ledger already held. */
  unchanged: number;
  /** How many pull requests are being seen for the very first time. */
  firstSighting: number;
}

/**
 * Drop observations that say nothing new.
 *
 * Re-running the collector must not inflate the ledger with identical rows — a
 * reader counting rows per pull request would then be measuring how often the
 * collector ran. An observation is kept when any field a reader would analyse
 * has moved; `observedAt` alone changing is not a change.
 */
export function dedupeAgainst(
  existing: readonly PrObservation[],
  incoming: readonly PrObservation[],
): DedupeResult {
  const latest = new Map<string, string>();
  const seen = new Set<string>();
  for (const o of existing) {
    const key = `${o.repo}#${o.number}`;
    seen.add(key);
    latest.set(key, fingerprint(o));
  }
  const toAppend: PrObservation[] = [];
  let unchanged = 0;
  let firstSighting = 0;
  for (const o of incoming) {
    const key = `${o.repo}#${o.number}`;
    const fp = fingerprint(o);
    if (latest.get(key) === fp) {
      unchanged++;
      continue;
    }
    if (!seen.has(key)) firstSighting++;
    seen.add(key);
    latest.set(key, fp);
    toAppend.push(o);
  }
  return { toAppend, unchanged, firstSighting };
}

export interface LedgerSummary {
  rows: number;
  distinctPrs: number;
  /**
   * Pull requests with more than one observation — the only ones that can show
   * a trajectory rather than a final state.
   */
  prsWithHistory: number;
  byState: Record<string, number>;
  /** Absent when NO row carried the field — not zero. */
  workerAuthored?: number;
  rosterlessRows: number;
}

export function summarise(rows: readonly PrObservation[]): LedgerSummary {
  const byPr = new Map<string, number>();
  const byState: Record<string, number> = {};
  let workerAuthored = 0;
  let anyRoster = false;
  let rosterless = 0;
  const latestState = new Map<string, string>();
  for (const o of rows) {
    const key = `${o.repo}#${o.number}`;
    byPr.set(key, (byPr.get(key) ?? 0) + 1);
    latestState.set(key, o.state);
    if (o.authorIsWorker === undefined) rosterless++;
    else {
      anyRoster = true;
      if (o.authorIsWorker) workerAuthored++;
    }
  }
  for (const s of latestState.values()) byState[s] = (byState[s] ?? 0) + 1;
  return {
    rows: rows.length,
    distinctPrs: byPr.size,
    prsWithHistory: [...byPr.values()].filter((n) => n > 1).length,
    byState,
    ...(anyRoster && { workerAuthored }),
    rosterlessRows: rosterless,
  };
}

export function formatLedgerSummary(s: LedgerSummary): string {
  const L: string[] = [];
  L.push("[pr-outcomes] what the ledger holds");
  if (s.rows === 0) {
    // Nothing recorded yet is a true and expected state on day one. Saying
    // "0 pull requests" invites someone to fix a number; what matters is that
    // the clock has not started.
    L.push("");
    L.push("  Nothing recorded yet. Outcome history accrues only with");
    L.push("  wall-clock time and cannot be backfilled — collect regularly");
    L.push("  and the trajectories appear from the next run on.");
    return L.join("\n");
  }
  L.push("");
  L.push(`  ${s.rows} observation(s) across ${s.distinctPrs} pull request(s)`);
  // The denominator that matters. One observation per pull request is a
  // snapshot, not a history, and a reader must not mistake the two.
  L.push(
    `  ${s.prsWithHistory} of ${s.distinctPrs} have more than one observation —`,
  );
  L.push("    only those can show how a PR changed between open and close.");
  L.push("");
  L.push("  latest state");
  for (const [k, v] of Object.entries(s.byState).sort()) {
    L.push(`    ${k.padEnd(8)} ${v}`);
  }
  if (s.workerAuthored !== undefined) {
    L.push("");
    L.push(`  ${s.workerAuthored} observation(s) authored by a known worker`);
  }
  if (s.rosterlessRows > 0) {
    L.push("");
    L.push(
      `  ${s.rosterlessRows} row(s) carry NO worker judgement — collected with`,
    );
    L.push(
      "    no roster, so whether a worker opened them is unknown, not false.",
    );
  }
  L.push("");
  L.push("  Raw events only. No score is derived here, on purpose: a number");
  L.push("  computed now would fix its weighting before there is anything to");
  L.push("  weigh it against.");
  return L.join("\n");
}
