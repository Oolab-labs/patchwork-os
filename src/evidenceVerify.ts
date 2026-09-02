/**
 * `patchwork evidence verify` — is the evidence spine internally intact?
 *
 * The offline reader ADR-0027 pairs with `appendChained`. Walks every ledger
 * on `SPINE_LEDGERS` through `verifyLedgerChain` and reduces to one verdict.
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
}

export function verifyEvidenceChains(
  dir = patchworkHome(),
): EvidenceVerification {
  const ledgers: LedgerVerification[] = [];
  for (const { key, file } of SPINE_LEDGERS) {
    const v = verifyLedgerChain(path.join(dir, file));
    ledgers.push({ ...v, key, file });
  }
  const ok = ledgers.every((l) => l.ok && l.writeFailedPending === 0);
  return { dir, ok, ledgers };
}

export function formatEvidenceVerify(r: EvidenceVerification): string {
  const L: string[] = [];
  L.push("[evidence verify] is the spine internally intact?");
  L.push(`  ${r.dir}`);
  L.push("");
  for (const l of r.ledgers) {
    if (l.absent) {
      L.push(`  ABSENT   ${l.file}`);
      continue;
    }
    const chainNote =
      l.chainedRows === 0 && l.legacyPrefix === "unchained"
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
  L.push(
    r.ok
      ? "STATUS: INTACT"
      : "STATUS: NOT INTACT — a break, a mismatch, a shortened file or an unsealed failure above",
  );
  L.push("");
  return L.join("\n");
}
