/**
 * The ambient memory card spliced into the MCP `instructions` block.
 *
 * Deliberately modelled on `tools/recentTracesDigest.ts` — same shape, same
 * discipline: a hard byte cap, per-line truncation, and a bounded item count.
 * There is no reason for a second style of budgeted context block, and one
 * consistent one is easier to reason about when both land in the same prompt.
 *
 * Three things this must not do:
 *
 *  - Include low-trust claims. Anything Butler READ (email, chat, calendar)
 *    sits below `ORIGINATE_THRESHOLD`; putting it here would let a stranger's
 *    email address the model directly in its system prompt, which is the whole
 *    OWASP ASI06 attack in one step.
 *  - Hide its own truncation. A card that silently drops the fact that mattered
 *    is worse than no card, so a dropped remainder is stated.
 *  - Present a stale belief as fresh. Age is rendered, because agents do not
 *    notice staleness on their own (arXiv 2605.06527) — the model can only
 *    weigh what it can see.
 */

import { sanitizeForPrompt } from "../promptSafety.js";
import type { ButlerFact } from "./types.js";
import { ORIGINATE_THRESHOLD } from "./types.js";

export { sanitizeForPrompt };

/** Matches recentTracesDigest's budget — the two share one prompt. */
export const MAX_CARD_BYTES = 2_048;
export const MAX_FACT_CHARS = 80;
export const DEFAULT_MAX_FACTS = 12;

const DAY = 86_400_000;

/** "today" | "3d ago" | "5mo ago" — coarse on purpose; precision is noise. */
function age(recordedAt: number, now: number): string {
  const d = Math.floor((now - recordedAt) / DAY);
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface MemoryCardOpts {
  now: number;
  maxFacts?: number;
  maxBytes?: number;
  /** Floor on trust. Defaults to ORIGINATE_THRESHOLD — established beliefs
   *  only. Lowering it puts attacker-influenceable text in the system prompt;
   *  callers should have a specific reason. */
  minTrust?: number;
}

/**
 * Render resolved facts as instruction lines. Returns [] when there is nothing
 * to say, so the caller can omit the section entirely rather than emit an empty
 * heading.
 */
export function buildMemoryCard(
  facts: readonly ButlerFact[],
  opts: MemoryCardOpts,
): string[] {
  const minTrust = opts.minTrust ?? ORIGINATE_THRESHOLD;
  const maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS;
  const maxBytes = opts.maxBytes ?? MAX_CARD_BYTES;

  const eligible = facts
    .filter((f) => f.trust >= minTrust)
    // Most recently recorded first: if the budget bites, lose the oldest.
    .slice()
    .sort((a, b) => b.recordedAt - a.recordedAt);

  if (eligible.length === 0) return [];

  const shown = eligible.slice(0, maxFacts);
  const lines = [
    "WHAT YOU KNOW ABOUT THE USER (Butler memory):",
    ...shown.map((f) => {
      // Sanitise BEFORE truncating: truncation must not be able to leave a
      // dangling half-escape, and the length budget should count the text
      // that is actually rendered.
      const body = truncate(
        sanitizeForPrompt(`${f.subject} ${f.predicate}: ${f.object}`),
        MAX_FACT_CHARS,
      );
      return `  • ${body} (${age(f.recordedAt, opts.now)})`;
    }),
  ];

  let dropped = eligible.length - shown.length;

  // Byte budget. Pop facts from the tail — never the heading, and never the
  // trailing notice, which is what makes the loss visible.
  while (lines.length > 1 && byteLen(lines, dropped) > maxBytes) {
    lines.pop();
    dropped++;
  }

  // Everything got squeezed out: say nothing rather than emit a bare heading
  // followed by an apology.
  if (lines.length === 1) return [];

  if (dropped > 0) {
    lines.push(
      `  (${dropped} more not shown — call butlerRecall for the full set)`,
    );
  }
  lines.push(
    "  Use these unless the user says otherwise. Do not restate them back unprompted.",
  );
  return lines;
}

/** Byte length including the notice line the caller may still append. */
function byteLen(lines: string[], dropped: number): number {
  const extra =
    dropped > 0
      ? `  (${dropped} more not shown — call butlerRecall for the full set)\n`
          .length
      : 0;
  return Buffer.byteLength(lines.join("\n"), "utf8") + extra;
}
