/**
 * Reader for the information-boundary receipt ledger (ADR-0021).
 *
 * ## Why this file exists at all
 *
 * `boundary_receipts.jsonl` was WRITE-ONLY in this repository. Every ADR-0021
 * enforcement decision was recorded, and `BoundaryReceiptLog.recent()` /
 * `.summary()` — the two methods whose own comment says they are "the shape a
 * dashboard or CLI summary wants" — had no production caller, no CLI verb, no
 * HTTP route and no page. The only thing in the workspace that read this
 * ledger lived in the separate, non-MIT control plane.
 *
 * ADR-0019:88-92 forbids precisely that: the local ledgers must stay fully
 * usable standalone, and degrading them in the direction that pushes someone
 * toward the paid product is the failure the open-core boundary was written to
 * prevent. ADR-0021:404-406 gives the sharper version — "people need to be able
 * to read the code that decides whether their confidential information leaves
 * the machine". Reading the code is worthless if you cannot read what it
 * decided. Nobody chose this; it happened by default, which is what made it
 * worth fixing before adding anything else.
 *
 * ## Why it reads the FILE and not the class
 *
 * `BoundaryReceiptLog` trims its in-memory array to 500 rows on load and again
 * on every write. A summary built on `.summary()` therefore answers over the
 * most recent 500 receipts while presenting as a total — a wrong denominator
 * on the one screen whose entire job is to state the denominator. This module
 * reads the ledger from disk for the same reason `summarisePrivacyShadow`
 * does, and the two now share a shape deliberately.
 *
 * ## What it must never do
 *
 * Surface a payload. The receipt type has no field for one by construction;
 * this reader additionally copies only whitelisted keys, so a hand-edited or
 * future-writer row carrying a prompt cannot turn the viewer into the thing
 * that publishes it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { patchworkPath } from "../patchworkHome.js";
import type { BoundaryDecision, Classification } from "./dataPolicy.js";

export const BOUNDARY_RECEIPTS_BASENAME = "boundary_receipts.jsonl";

/** How many receipts the detail list carries. The summary counts all of them. */
const DEFAULT_RECENT = 20;

export function boundaryReceiptsPath(dir?: string): string {
  return dir
    ? path.join(dir, BOUNDARY_RECEIPTS_BASENAME)
    : patchworkPath(BOUNDARY_RECEIPTS_BASENAME);
}

/**
 * One receipt as this module is willing to hand it onward.
 *
 * An explicit field list, not a pass-through of the parsed row. The receipt
 * type has no payload field, but a reader that spread whatever it found on
 * disk would publish one the moment anything else wrote one.
 */
export interface BoundaryReceiptView {
  seq?: number;
  at: number;
  /**
   * Writer-stamped record level, carried through verbatim. ABSENT means the row
   * pre-dates the protocol — never defaulted to 0 on read, which would be a
   * backfill performed invisibly on every load.
   */
  rv?: number;
  /** The run that produced this receipt (`taskId`, never `seq`). */
  correlationId?: string;
  decision: BoundaryDecision;
  classification: Classification;
  categories?: string[];
  destinationId: string;
  destinationType?: "local" | "remote";
  redactCategories?: string[];
  reason: string;
  recipeName?: string;
  workspaceId?: string;
}

export interface BoundaryReceiptsSummary {
  /** The denominator: every decision recorded, INCLUDING the allowed ones. */
  recorded: number;
  /**
   * Decisions that were not a plain ALLOW — refused, rerouted, redacted or
   * escalated. Never rendered without `recorded` beside it.
   */
  refusals: number;
  byDecision: Record<string, number>;
  byDestination: Record<string, number>;
  byClassification: Record<string, number>;
  /**
   * Recipe -> how many of ITS dispatches were not plain ALLOW.
   *
   * A to-do list rather than another statistic: the remedy for a refusal is
   * usually to fix the step that produced it, and #1469 established that a
   * count with no recipe leaves an operator guessing between every installed
   * recipe.
   */
  refusalsByRecipe: Record<string, number>;
  /**
   * Refusals carrying no recipe name — rows written before attribution
   * existed. Reported rather than dropped so
   * `sum(refusalsByRecipe) + refusalsUnattributed === refusals` holds.
   */
  refusalsUnattributed: number;
  earliest?: number;
  latest?: number;
  /** Echoed back so a filtered report cannot be mistaken for the whole ledger. */
  since?: number;
  /** Lines that could not be parsed. Reported, never silently skipped. */
  unreadableLines: number;
  /** True only if a caller-supplied row limit actually cut the ledger short. */
  truncated: boolean;
  recent: BoundaryReceiptView[];
}

export interface SummariseReceiptsOptions {
  /** Directory holding the ledger. Defaults to `${PATCHWORK_HOME}`. */
  dir?: string;
  /** Only count decisions at or after this timestamp. */
  since?: number;
  /** How many receipts to carry in `recent`. Does not affect the counts. */
  recentLimit?: number;
  /** Stop after this many rows. Sets `truncated` when it bites. */
  maxRows?: number;
}

function view(r: Record<string, unknown>): BoundaryReceiptView | null {
  if (typeof r.at !== "number" || typeof r.decision !== "string") return null;
  const str = (k: string): string | undefined =>
    typeof r[k] === "string" ? (r[k] as string) : undefined;
  const arr = (k: string): string[] | undefined =>
    Array.isArray(r[k])
      ? (r[k] as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;
  const dt = str("destinationType");
  return {
    ...(typeof r.seq === "number" ? { seq: r.seq } : {}),
    // `rv` and `correlationId` are copied EXPLICITLY because this literal
    // enumerates every field rather than spreading `r`. That shape is
    // deliberate — a spread would let arbitrary file content reach a caller —
    // but it also means a newly-written field is silently dropped until someone
    // adds a line here, which is precisely how a `forbid` decision came to be
    // written correctly and discarded by every reader (#1517), and how
    // `workspaceId` was thrown away by the last step of its own pipeline.
    ...(typeof r.rv === "number" ? { rv: r.rv } : {}),
    ...(str("correlationId") ? { correlationId: str("correlationId") } : {}),
    at: r.at,
    decision: r.decision as BoundaryDecision,
    classification: (str("classification") ?? "internal") as Classification,
    ...(arr("categories")?.length ? { categories: arr("categories") } : {}),
    destinationId: str("destinationId") ?? "",
    ...(dt === "local" || dt === "remote" ? { destinationType: dt } : {}),
    ...(arr("redactCategories")?.length
      ? { redactCategories: arr("redactCategories") }
      : {}),
    reason: str("reason") ?? "",
    ...(str("recipeName") ? { recipeName: str("recipeName") } : {}),
    ...(str("workspaceId") ? { workspaceId: str("workspaceId") } : {}),
  };
}

export function summariseBoundaryReceipts(
  opts: SummariseReceiptsOptions = {},
): BoundaryReceiptsSummary {
  const s: BoundaryReceiptsSummary = {
    recorded: 0,
    refusals: 0,
    byDecision: {},
    byDestination: {},
    byClassification: {},
    refusalsByRecipe: {},
    refusalsUnattributed: 0,
    unreadableLines: 0,
    truncated: false,
    recent: [],
    ...(opts.since !== undefined ? { since: opts.since } : {}),
  };

  let text: string;
  try {
    text = readFileSync(boundaryReceiptsPath(opts.dir), "utf-8");
  } catch {
    // No ledger yet. Rendered as "nothing recorded" — never as "0 refusals",
    // which would read as a clean bill of health for a boundary that has not
    // run.
    return s;
  }

  const kept: BoundaryReceiptView[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (opts.maxRows !== undefined && s.recorded >= opts.maxRows) {
      s.truncated = true;
      break;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(t) as Record<string, unknown>;
    } catch {
      s.unreadableLines += 1;
      continue;
    }
    const v = view(parsed);
    if (!v) {
      s.unreadableLines += 1;
      continue;
    }
    if (opts.since !== undefined && v.at < opts.since) continue;

    s.recorded += 1;
    s.byDecision[v.decision] = (s.byDecision[v.decision] ?? 0) + 1;
    if (v.destinationId) {
      s.byDestination[v.destinationId] =
        (s.byDestination[v.destinationId] ?? 0) + 1;
    }
    s.byClassification[v.classification] =
      (s.byClassification[v.classification] ?? 0) + 1;
    if (v.decision !== "ALLOW") {
      s.refusals += 1;
      if (v.recipeName) {
        s.refusalsByRecipe[v.recipeName] =
          (s.refusalsByRecipe[v.recipeName] ?? 0) + 1;
      } else {
        s.refusalsUnattributed += 1;
      }
    }
    if (s.earliest === undefined || v.at < s.earliest) s.earliest = v.at;
    if (s.latest === undefined || v.at > s.latest) s.latest = v.at;
    kept.push(v);
  }

  s.recent = kept.slice(-(opts.recentLimit ?? DEFAULT_RECENT)).reverse();
  return s;
}

const PAD = 16;

/**
 * Render the denominator FIRST, and never a bare refusal count.
 *
 * Same doctrine as `formatPrivacyShadow`, for the same reason: "2 refusals"
 * invites the reading that everything else was fine, and on an empty ledger it
 * would state a clean bill of health for a boundary that has never run.
 */
export function formatBoundaryReceipts(s: BoundaryReceiptsSummary): string {
  const L: string[] = [];
  if (s.recorded === 0) {
    L.push("[privacy-receipts] nothing recorded");
    L.push(
      s.unreadableLines > 0
        ? `  The ledger exists but no line in it could be read (${s.unreadableLines} unreadable).`
        : "  The boundary has written no receipt in this workspace.",
    );
    L.push(
      "  That means no agent step has dispatched since it was enabled, or no",
    );
    L.push(
      "  destination is registered under `privacy.destinations` — the boundary",
    );
    L.push("  is inert until one is. It does NOT mean nothing was refused.");
    return L.join("\n");
  }

  L.push(`[privacy-receipts] ${s.recorded} boundary decisions recorded`);
  if (s.since !== undefined) {
    L.push(`  window        since ${new Date(s.since).toISOString()}`);
  } else if (s.earliest !== undefined && s.latest !== undefined) {
    L.push(
      `  window        ${new Date(s.earliest).toISOString()} → ${new Date(s.latest).toISOString()}`,
    );
  }
  L.push(
    `  ${s.refusals} of ${s.recorded} were refused, rerouted or held for approval`,
  );

  L.push("  by decision");
  for (const [k, v] of Object.entries(s.byDecision).sort(
    (a, b) => b[1] - a[1],
  )) {
    L.push(`    ${k.padEnd(PAD)} ${String(v).padStart(5)}`);
  }

  L.push("  by destination");
  for (const [k, v] of Object.entries(s.byDestination).sort(
    (a, b) => b[1] - a[1],
  )) {
    L.push(`    ${k.padEnd(PAD)} ${String(v).padStart(5)}`);
  }

  const recipes = Object.entries(s.refusalsByRecipe).sort(
    (a, b) => b[1] - a[1],
  );
  if (recipes.length || s.refusalsUnattributed) {
    L.push("  refusals by recipe — the fix list");
    for (const [k, v] of recipes) {
      L.push(`    ${k.padEnd(PAD)} ${String(v).padStart(5)}`);
    }
    if (s.refusalsUnattributed) {
      L.push(
        `    ${"(unattributed)".padEnd(PAD)} ${String(s.refusalsUnattributed).padStart(5)}`,
      );
    }
  }

  if (s.unreadableLines > 0) {
    L.push(`  ${s.unreadableLines} unreadable line(s) skipped`);
  }
  if (s.truncated) {
    L.push("  TRUNCATED — a row limit cut this short; counts are a floor");
  }
  L.push(
    "  (declared metadata only — this ledger has no field for the prompt)",
  );
  return L.join("\n");
}
