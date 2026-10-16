/**
 * `patchwork evidence verify` — is the evidence spine internally intact?
 *
 * The offline reader ADR-0027 pairs with `appendChained`. Walks every ledger
 * on `VERIFIED_LEDGERS` through `verifyLedgerChain` and reduces to one verdict.
 *
 * Unlike `patchwork evidence`, this one GATES: `ok: false` and exit 1 on any
 * break, on a legacy-prefix mismatch, on a head sidecar that says the file
 * used to be longer, and on a PENDING write-failure count — because a ledger
 * that stopped writing is a different fact from a quiet day and this is the
 * command that is supposed to say so.
 *
 * Prints counts and positions (line number, iseq) only, never a value. A line
 * number is not operator data; a row is.
 */

import path from "node:path";
import { SPINE_LEDGERS } from "./evidenceCoverage.js";
import { type ChainVerification, verifyLedgerChain } from "./ledgerChain.js";
import { patchworkHome } from "./patchworkHome.js";

export interface LedgerVerification extends ChainVerification {
  key: string;
  /** Relative to `dir` — what the report prints. */
  file: string;
}

export interface EvidenceVerification {
  dir: string;
  ok: boolean;
  ledgers: LedgerVerification[];
  /** Present ledgers whose chain was walked (chained rows > 0, or an intact legacy+chain file). */
  verified: number;
  /** No file and no sidecar: never written here. Legitimate for a ledger with no evidence yet. */
  absent: number;
  /** Present, legacy rows only, no chain-start yet. Non-fatal unless `expectChained`. */
  unchained: number;
  /** File gone, `.head` sidecar remains: deleted. Always a break. */
  missingWithHead: number;
  /** Whether `unchained` was treated as a failure. */
  expectChained: boolean;
}

export interface VerifyEvidenceOpts {
  /** Treat a legacy-only (never chained) ledger as NOT ok. */
  expectChained?: boolean;
}

/**
 * What `evidence verify` walks: the spine PLUS chained ledgers that are not
 * on it. Kept SEPARATE from `SPINE_LEDGERS` on purpose — that list is the
 * correlation/coverage set behind `patchwork evidence`'s denominators, and a
 * ledger that carries no run id has no business in a "rows carry a run id"
 * count. Wave 2 of ADR-0027 appends here, one ledger per PR.
 */
export const VERIFIED_LEDGERS: ReadonlyArray<{ key: string; file: string }> = [
  ...SPINE_LEDGERS,
  { key: "butler outcome shadow", file: "butler_outcome_shadow.jsonl" },
  { key: "run steps", file: "run_steps.jsonl" },
  { key: "pr outcomes", file: "pr_outcomes.jsonl" },
];

export function isUnchained(l: ChainVerification): boolean {
  return !l.absent && l.chainedRows === 0 && l.legacyPrefix === "unchained";
}

export function verifyEvidenceChains(
  dir = patchworkHome(),
  opts: VerifyEvidenceOpts = {},
): EvidenceVerification {
  const expectChained = opts.expectChained === true;
  const ledgers: LedgerVerification[] = [];
  for (const { key, file } of VERIFIED_LEDGERS) {
    const v = verifyLedgerChain(path.join(dir, file));
    ledgers.push({ ...v, key, file });
  }
  const missingWithHead = ledgers.filter(
    (l) => l.absent && l.head === "orphaned",
  ).length;
  const absent = ledgers.filter(
    (l) => l.absent && l.head !== "orphaned",
  ).length;
  const unchained = ledgers.filter(isUnchained).length;
  const verified = ledgers.filter((l) => !l.absent && !isUnchained(l)).length;
  // Every ledger that exists must verify, a deleted one is a break, and a
  // verdict over ZERO verified ledgers is not a verdict: a wrong --dir and a
  // clean spine must not print the same word (audit 2026-10-15, H6).
  const ok =
    ledgers.every((l) => l.ok && l.writeFailedPending === 0) &&
    verified > 0 &&
    (!expectChained || unchained === 0);
  return {
    dir,
    ok,
    ledgers,
    verified,
    absent,
    unchained,
    missingWithHead,
    expectChained,
  };
}

export function formatEvidenceVerify(r: EvidenceVerification): string {
  const L: string[] = [];
  L.push("[evidence verify] is the spine internally intact?");
  L.push(`  ${r.dir}`);
  L.push("");
  for (const l of r.ledgers) {
    if (l.absent && l.head === "orphaned") {
      L.push(
        `  MISSING  ${l.file}  file is gone but its .head sidecar remains — it used to exist`,
      );
      continue;
    }
    if (l.absent) {
      L.push(`  ABSENT   ${l.file}`);
      continue;
    }
    const unchained = isUnchained(l);
    const chainNote = unchained
      ? `${l.legacyRows} legacy row(s), no chain yet`
      : `${l.chainedRows} chained row(s), legacy prefix ${l.legacyPrefix}` +
        (l.legacyRows > 0 ? ` (${l.legacyRows} row(s))` : "") +
        (l.rotations > 0
          ? `, ${l.droppedByRotation} row(s) removed by rotation`
          : "") +
        (l.writeFailedSealed > 0
          ? `, ${l.writeFailedSealed} failed append(s) sealed`
          : "") +
        `, head ${l.head}`;
    const state = !l.ok
      ? "BROKEN"
      : l.writeFailedPending > 0
        ? "PENDING"
        : unchained
          ? "UNCHAINED"
          : "OK";
    L.push(`  ${state.padEnd(8)} ${l.file}  ${chainNote}`);
    for (const b of l.breaks) {
      L.push(
        `           ${b.kind} break at line ${b.line}` +
          (b.iseq !== null ? ` (iseq ${b.iseq})` : ""),
      );
    }
    if (l.legacyPrefix === "mismatch") {
      L.push(
        "           legacy prefix does not match the chain-start commitment",
      );
    }
    if (l.writeFailedPending > 0) {
      L.push(
        `           ${l.writeFailedPending} append(s) failed since the last row landed — not yet sealed`,
      );
    }
  }
  L.push("");
  const counts =
    `${r.verified} of ${r.ledgers.length} verified, ${r.absent} absent` +
    (r.unchained > 0 ? `, ${r.unchained} unchained` : "") +
    (r.missingWithHead > 0 ? `, ${r.missingWithHead} missing` : "");
  if (r.verified === 0 && r.missingWithHead === 0) {
    L.push(
      `STATUS: NOTHING VERIFIED (${counts}) — no ledger found under this directory; a wrong --dir and a clean spine must not read the same`,
    );
  } else if (r.ok) {
    L.push(`STATUS: INTACT (${counts})`);
  } else if (
    r.expectChained &&
    r.unchained > 0 &&
    r.ledgers.every((l) => l.ok && l.writeFailedPending === 0)
  ) {
    L.push(
      `STATUS: NOT INTACT (${counts}) — --expect-chained and a ledger carries legacy rows only`,
    );
  } else {
    L.push(
      `STATUS: NOT INTACT (${counts}) — a break, a mismatch, a shortened or deleted file or an unsealed failure above`,
    );
  }
  L.push("");
  return L.join("\n");
}
