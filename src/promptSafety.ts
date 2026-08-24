/**
 * Prompt-structure safety, shared by every surface that renders stored text
 * into the instructions block.
 *
 * ## Why this is its own module
 *
 * It used to live in `src/butler/memoryCard.ts`, and the session traces digest
 * — which renders into the SAME prompt from `buildInstructions()`, a few lines
 * away — did not call it. One prompt-rendering path was hardened and its
 * neighbour was not: the partial-surface failure this codebase keeps
 * rediscovering. `AGENT_STEP_TOOL` was centralised for exactly this reason —
 * two sites holding the same rule independently is how they drift.
 *
 * The digest is the sharper of the two cases. Butler facts are graded by
 * provenance, and anything merely READ from a connector is held below the
 * card's origination floor. A decision trace is written by `ctxSaveTrace` — a
 * tool any connected agent can call — and is spliced into every session's
 * instructions within 12 hours, ordered by recency alone, with no verification.
 * Both the write and the read are agent-reachable, so the render is the only
 * place the structure can be defended.
 *
 * ## What this is NOT
 *
 * Not a content filter, and it must never become one. It cannot tell whether a
 * stored lesson is true, sensible or hostile — only that it cannot forge the
 * SHAPE of an instruction. Judging the content would be detection, which
 * ADR-0021 rejects as a boundary for the same reason.
 */

/**
 * Collapse anything that could forge structure in the instructions block.
 *
 * This card renders fact text straight into a SYSTEM PROMPT. The store
 * deliberately accepts any UTF-8 except NUL (a belief is arbitrary text), so
 * the safety boundary has to be here, at the point of rendering — and it has
 * to be here rather than at write time, because rows written before this
 * existed are already on disk.
 *
 * Stripped:
 *   - C0/C1 controls including \n and \r — a newline lets a value emit a
 *     second line and impersonate a real instruction heading; a lone \r
 *     rewrites the line in a terminal render.
 *   - U+2028/U+2029 — Unicode line/paragraph separators, newlines by another
 *     name in most renderers.
 *   - U+202A–U+202E, U+2066–U+2069 — bidi overrides, which reorder displayed
 *     text without changing the bytes, so a value can appear to say something
 *     other than what is stored.
 *
 * Replaced with a space, not removed: deleting them would silently join words
 * that were separate, which changes the meaning of the belief.
 */
const UNSAFE_IN_PROMPT =
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeForPrompt(s: string): string {
  return s.replace(UNSAFE_IN_PROMPT, " ").replace(/\s+/g, " ").trim();
}
