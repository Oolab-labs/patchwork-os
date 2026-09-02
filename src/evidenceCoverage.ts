/**
 * `patchwork evidence` — how much of the evidence spine can actually be joined?
 *
 * CLAUDE.md's Evidence Spine section tells the next session to re-measure this
 * before scoping a cross-ledger reader, and says why in its own words: two of
 * its load-bearing claims "went stale or were wrong within two days". Doing that
 * measurement took a bespoke throwaway script every time. This makes it a verb.
 *
 * ## It reports denominators. It is NOT the reader.
 *
 * The spine's rule is "do NOT build the readers ahead of the evidence" — a
 * cross-ledger graph built now would be a view over data that does not exist,
 * and the shape of the view would then dictate the shape of the evidence,
 * backwards. So this answers the question that comes FIRST: how many rows carry
 * a correlation id at all, and how many runs appear in more than one ledger.
 * Measured 2026-08-26 on the reference machine, the answer was ZERO runs in
 * both — which is the fact that keeps the reader unbuilt.
 *
 * ## Absent is not zero
 *
 * A ledger that does not exist is reported ABSENT, never as `0 rows`. They are
 * different facts: `butler/permission_exercises.jsonl` is absent because no
 * standing permission has ever been granted, and that absence is CORRECT rather
 * than a gap to plumb. Rendering it as a zero row would invite someone to go and
 * "fix" it.
 *
 * ## Counts only, never contents
 *
 * These ledgers hold real task titles, captured output tails and third-party
 * record ids, and a correlation id IS a run's `taskId`. So nothing here prints a
 * row, an id, or any value — only counts and the file name. The house rule is
 * that a measurement may leave the machine and the rows may not.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isChainMarker } from "./ledgerChain.js";
import { patchworkHome } from "./patchworkHome.js";

/** Ledgers on the spine, with where each lives relative to `$PATCHWORK_HOME`. */
export const SPINE_LEDGERS: ReadonlyArray<{ key: string; file: string }> = [
  { key: "gate decisions", file: "worker_gate_decisions.jsonl" },
  { key: "boundary receipts", file: "boundary_receipts.jsonl" },
  { key: "privacy shadow", file: "privacy_shadow.jsonl" },
  { key: "outcomes", file: "outcome-log.jsonl" },
  { key: "approvals", file: "approval_log.jsonl" },
  { key: "permission exercises", file: "butler/permission_exercises.jsonl" },
];

export interface LedgerCoverage {
  key: string;
  file: string;
  /** True when the file does not exist. Distinct from `rows === 0`. */
  absent: boolean;
  rows: number;
  /** Rows carrying a `correlationId` — the joinable population. */
  joinable: number;
  /** Distinct correlation ids, i.e. how many runs this ledger can speak about. */
  distinctRuns: number;
  /** Lines that would not parse. Reported, never silently skipped. */
  corrupt: number;
}

export interface PairCoverage {
  a: string;
  b: string;
  shared: number;
}

export interface EvidenceCoverage {
  dir: string;
  ledgers: LedgerCoverage[];
  /** Only pairs where BOTH sides have at least one joinable row. */
  pairs: PairCoverage[];
  /** Runs reachable in more than one ledger — what a reader could traverse. */
  runsInMoreThanOneLedger: number;
}

function scan(dir: string, key: string, file: string) {
  const full = path.join(dir, file);
  if (!existsSync(full)) {
    return {
      cov: {
        key,
        file,
        absent: true,
        rows: 0,
        joinable: 0,
        distinctRuns: 0,
        corrupt: 0,
      } satisfies LedgerCoverage,
      ids: new Set<string>(),
    };
  }
  let text = "";
  try {
    text = readFileSync(full, "utf-8");
  } catch {
    // Unreadable is not absent — say so by reporting it as present with a
    // corrupt count rather than pretending the file is not there.
    return {
      cov: {
        key,
        file,
        absent: false,
        rows: 0,
        joinable: 0,
        distinctRuns: 0,
        corrupt: 1,
      } satisfies LedgerCoverage,
      ids: new Set<string>(),
    };
  }
  const ids = new Set<string>();
  let rows = 0;
  let joinable = 0;
  let corrupt = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      corrupt++;
      continue;
    }
    // ADR-0027 marker rows share the file and are not evidence: counting one
    // inflates the denominator by exactly one per chained ledger, silently.
    if (isChainMarker(parsed)) continue;
    rows++;
    const c = (parsed as { correlationId?: unknown }).correlationId;
    if (typeof c === "string" && c !== "") {
      joinable++;
      ids.add(c);
    }
  }
  return {
    cov: {
      key,
      file,
      absent: false,
      rows,
      joinable,
      distinctRuns: ids.size,
      corrupt,
    } satisfies LedgerCoverage,
    ids,
  };
}

export function evidenceCoverage(dir = patchworkHome()): EvidenceCoverage {
  const ledgers: LedgerCoverage[] = [];
  const idsByKey = new Map<string, Set<string>>();
  for (const { key, file } of SPINE_LEDGERS) {
    const { cov, ids } = scan(dir, key, file);
    ledgers.push(cov);
    idsByKey.set(key, ids);
  }

  const pairs: PairCoverage[] = [];
  const withIds = [...idsByKey.entries()].filter(([, s]) => s.size > 0);
  for (let i = 0; i < withIds.length; i++) {
    for (let j = i + 1; j < withIds.length; j++) {
      const [a, sa] = withIds[i] as [string, Set<string>];
      const [b, sb] = withIds[j] as [string, Set<string>];
      let shared = 0;
      for (const id of sa) if (sb.has(id)) shared++;
      pairs.push({ a, b, shared });
    }
  }

  const seen = new Map<string, number>();
  for (const [, s] of idsByKey) {
    for (const id of s) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  let runsInMoreThanOneLedger = 0;
  for (const [, n] of seen) if (n > 1) runsInMoreThanOneLedger++;

  return { dir, ledgers, pairs, runsInMoreThanOneLedger };
}

export function formatEvidenceCoverage(c: EvidenceCoverage): string {
  const L: string[] = [];
  L.push("[evidence] how much of the spine can be joined?");
  L.push(`  ${c.dir}`);
  L.push("");
  for (const l of c.ledgers) {
    if (l.absent) {
      // Absence can be the CORRECT state — no standing permission has ever been
      // granted, so its ledger not existing is not a gap to plumb.
      L.push(`  ABSENT   ${l.file}`);
      continue;
    }
    // Always the denominator first: "14 joinable" reads as coverage,
    // "14 of 170" is the fact.
    L.push(
      `  ${String(l.joinable).padStart(5)} of ${String(l.rows).padEnd(6)} rows carry a run id` +
        `  (${l.distinctRuns} distinct run${l.distinctRuns === 1 ? "" : "s"})  ${l.file}` +
        (l.corrupt > 0 ? `  [${l.corrupt} unparseable]` : ""),
    );
  }
  L.push("");
  if (c.pairs.length === 0) {
    L.push(
      "  No two ledgers both carry run ids yet, so nothing can be joined.",
    );
  } else {
    L.push("  Runs shared between ledgers:");
    for (const p of c.pairs) {
      L.push(`    ${p.shared}  ${p.a} ↔ ${p.b}`);
    }
  }
  L.push("");
  L.push(
    `  A cross-ledger reader could traverse ${c.runsInMoreThanOneLedger} run(s) today.`,
  );
  if (c.runsInMoreThanOneLedger === 0) {
    L.push(
      "  That is the number that keeps the evidence graph unbuilt — a reader now",
    );
    L.push(
      "  would be a view over data that does not exist, and its shape would then",
    );
    L.push(
      "  dictate the shape of the evidence rather than the other way round.",
    );
  }
  L.push("");
  return `${L.join("\n")}\n`;
}
