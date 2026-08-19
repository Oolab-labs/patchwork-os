/**
 * Promote graded Butler shadow rows into the trust ledger — flag-gated, OFF.
 *
 * ## Why this is a separate module and not a branch in the ingester
 *
 * `outcomeIngester.ts` and `errandOutcomeGrader.ts` each carry a test asserting
 * they cannot reach `OutcomeStore` — not "do not call it", but *do not import
 * anything that could*. That is what makes "shadow-only" a structural fact
 * rather than a promise, and it is why a reviewer can read the grader without
 * checking whether some path in it writes evidence.
 *
 * Adding promotion there would have meant deleting those guards. This module
 * exists so they stay exactly as they are: the grader stays a pure function of
 * observed state, the ingester stays unable to write trust, and the single
 * place that can is this one, which does nothing else.
 *
 * ## Operator path only
 *
 * Not registered as a recipe tool, and a test asserts it. A recipe step runs AS
 * the worker, so a worker able to reach this could promote its own filings —
 * manufacturing the evidence that raises its own dial. Same reasoning as
 * `outcomes confirm|reject`, which is also operator-only for exactly this.
 *
 * ## Flag-gated OFF, and the flag is about EVIDENCE, not about code
 *
 * Promotion is one-way in the way that matters: once a row is folded, the dial
 * it moved cannot be un-moved by deleting the row, because trust replay has
 * already absorbed it into a checkpoint. So the gate is not "is the code
 * finished" — it is "is there enough evidence to start counting this channel".
 *
 * At the time of writing the shadow ledger holds ONE confirmed row. That is a
 * real positive act, correctly attributed, and it is one row. The flag exists so
 * the code can be reviewed, tested and merged now, and the trust decision made
 * later on more of them, by a person, deliberately.
 *
 * ## What is promoted, and what is refused
 *
 * Only `confirmed` and `junk` — the two dispositions that represent a POSITIVE
 * ACT by the operator. `unknown` is never promoted under any flag, because
 * "nobody has acted yet" is not evidence in either direction, and folding it as
 * good is the trust-by-neglect defect closed four times already in this
 * subsystem (#1064, #1318/#1319, #1320, #1322).
 *
 * ## `origin: "ingester"`, never `"manual"`
 *
 * `OutcomeStore` treats a `"manual"` disposition as STICKY against later
 * ingester writes, because it represents a human's explicit judgment. Nothing
 * here is that: it is an automated grade derived from an HTTP response. Marking
 * these `"manual"` would let an automated observation permanently override an
 * operator who had explicitly ruled the other way — precisely inverting the
 * precedence the field exists to protect.
 */

import { OutcomeStore } from "../workers/outcomeStore.js";
import {
  readShadowRows,
  type ShadowOutcomeRow,
  wouldCountAsEvidence,
} from "./outcomeShadowLog.js";

/** Feature flag. Absent or anything but a truthy value ⇒ promotion refuses. */
export const BUTLER_PROMOTE_FLAG = "PATCHWORK_FLAG_BUTLER_PROMOTE";

export interface PromoteOptions {
  /** `~/.patchwork` override (tests). */
  patchworkDir: string;
  /** Clock, injected so a written record is reproducible in tests. */
  now?: number;
  /** Report only; write nothing. Independent of the flag. */
  dryRun?: boolean;
  /** Flag override, injected rather than read from the environment in tests. */
  enabled?: boolean;
}

export interface PromoteResult {
  /** Every graded row considered — the DENOMINATOR, always reported. */
  rows: number;
  /** Rows whose disposition is `confirmed` or `junk`. */
  promotable: number;
  /** Rows withheld because the grader said `unknown`. */
  withheld: number;
  /** Rows written to the outcome log. Zero on a dry run or with the flag off. */
  promoted: number;
  /** Rows already carrying the same disposition in the trust ledger. */
  alreadyRecorded: number;
  /** Rows whose stored ref could not be turned back into a key, with why. */
  unkeyable: { ref: string; reason: string }[];
  /** True when nothing was written because the flag is off. */
  blockedByFlag: boolean;
}

function flagEnabled(opts: PromoteOptions): boolean {
  if (opts.enabled !== undefined) return opts.enabled;
  const v = process.env[BUTLER_PROMOTE_FLAG];
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Split a stored `"<tool>:<id>"` key back into its parts.
 *
 * On the FIRST colon, which is the inverse of how `canonicalActionRef` joins
 * them. Tool ids in this repo are dot-separated (`todoist.create_task`) and
 * never contain a colon, while connector ids routinely do — so splitting on the
 * last colon, or on every colon, would silently rekey the action and attach a
 * confirmation to nothing.
 *
 * A URL-shaped key is refused rather than split. Those belong to the legacy
 * `issueUrl` namespace, which `canonicalActionRef` explicitly refuses to
 * produce; treating one as a `ref` here would write a row under a key no reader
 * looks for.
 */
export function splitStoredRef(
  stored: string,
): { tool: string; id: string } | { error: string } {
  if (/^https?:\/\//i.test(stored)) {
    return {
      error:
        "URL-shaped key belongs to the legacy issueUrl namespace, not the tool/id one",
    };
  }
  const i = stored.indexOf(":");
  if (i <= 0 || i === stored.length - 1) {
    return { error: "not in '<tool>:<id>' form" };
  }
  return { tool: stored.slice(0, i), id: stored.slice(i + 1) };
}

/**
 * Fold graded shadow rows into the trust ledger.
 *
 * Idempotent: a row whose disposition already matches what the ledger holds is
 * counted as `alreadyRecorded` and NOT rewritten. `upsert` appends, so
 * re-running without this would grow the file the autonomy gate reads with rows
 * that say nothing new — and that file's byte cap is already what starves trust
 * evidence (#1337).
 */
export function promoteShadowOutcomes(opts: PromoteOptions): PromoteResult {
  const rows: ShadowOutcomeRow[] = readShadowRows(opts.patchworkDir);
  const enabled = flagEnabled(opts);
  const result: PromoteResult = {
    rows: rows.length,
    promotable: 0,
    withheld: 0,
    promoted: 0,
    alreadyRecorded: 0,
    unkeyable: [],
    blockedByFlag: !enabled,
  };

  const store = new OutcomeStore(opts.patchworkDir);
  const now = opts.now ?? Date.now();

  // Last grade wins per ref. The ledger is append-only and an errand is
  // observed repeatedly, so the same ref legitimately appears many times —
  // promoting each one would write the same fact over and over, and an older
  // grade could land after a newer one.
  const latest = new Map<string, ShadowOutcomeRow>();
  for (const row of rows) {
    const prev = latest.get(row.ref);
    if (!prev || row.gradedAt >= prev.gradedAt) latest.set(row.ref, row);
  }

  for (const row of latest.values()) {
    if (!wouldCountAsEvidence(row.disposition)) {
      result.withheld++;
      continue;
    }
    result.promotable++;

    const parts = splitStoredRef(row.ref);
    if ("error" in parts) {
      // Reported, never dropped. A row that cannot be keyed is a measurement
      // gap, and a run that silently skipped some looks identical to a clean one.
      result.unkeyable.push({ ref: row.ref, reason: parts.error });
      continue;
    }

    if (store.getDispositionForRef(parts) === row.disposition) {
      result.alreadyRecorded++;
      continue;
    }

    if (!enabled || opts.dryRun) continue;

    store.upsert({
      ref: parts,
      disposition: row.disposition,
      checkedAt: now,
      ...(row.recipe ? { recipeName: row.recipe } : {}),
      // NOT "manual" — see the header. This is an automated grade, and marking
      // it manual would make it sticky against a human who ruled otherwise.
      origin: "ingester",
    });
    result.promoted++;
  }

  return result;
}

/**
 * Render the result.
 *
 * Leads with the denominator and never prints a bare promoted count, for the
 * same reason the privacy shadow report refuses to: "3 promoted" reads as a
 * measure of the channel's health when it partly measures how little was
 * observed.
 */
export function formatPromoteResult(r: PromoteResult): string {
  const lines: string[] = [];
  lines.push(`[butler-promote] ${r.rows} graded row(s) in the shadow ledger`);
  lines.push(
    `  ${r.promotable} promotable (confirmed or junk) · ${r.withheld} withheld as unknown`,
  );
  if (r.alreadyRecorded > 0) {
    lines.push(`  ${r.alreadyRecorded} already recorded with the same verdict`);
  }
  for (const u of r.unkeyable) {
    lines.push(`  unkeyable ${u.ref}: ${u.reason}`);
  }
  lines.push("");
  if (r.blockedByFlag) {
    lines.push(
      `  NOTHING WAS WRITTEN — ${BUTLER_PROMOTE_FLAG} is not set, so this run`,
    );
    lines.push("  was a report. Promotion moves the trust dial and a folded");
    lines.push("  row cannot be un-folded by deleting it, so it is off until");
    lines.push("  a person turns it on against evidence they have read.");
  } else {
    lines.push(`  ${r.promoted} row(s) written to the trust ledger.`);
  }
  return `${lines.join("\n")}\n`;
}
