/**
 * Judge verdict — PR3a.
 *
 * Parses a free-form agent response into a structured `JudgeVerdict`.
 * The judge prompt convention asks the model to end its response with
 * a JSON object of the form:
 *
 *   {"verdict": "approve" | "request_changes",
 *    "reasons": ["..."],
 *    "fixList": ["..."]}
 *
 * The parser walks back from the end of the string, finds the last
 * JSON object, and validates its shape. On any failure we record the
 * verdict as `unparseable` and keep the raw text — the runner *never*
 * throws on a malformed judge response.
 *
 * **Augment-only invariant** — see the file-level comment in
 * yamlRunner.ts. The verdict shape is intentionally separate from
 * `StepResult.status`: a `request_changes` verdict produces
 * `status: "ok"` with a stashed verdict, never `status: "error"`.
 * That separation is what prevents the judge step from quietly
 * becoming a gate.
 *
 * ⚠️ OPT-IN DEPARTURE (judge→refine loop) — when a judge step sets the
 * opt-in `agent.max_revisions > 0` (with `kind: "judge"` + `reviews`),
 * the runner DELIBERATELY departs the augment-only invariant: a
 * `request_changes` verdict drives a bounded revise→re-judge loop and
 * MAY end with `status: "error"` (`on_exhausted: "halt"`). This is the
 * single sanctioned exception and is reachable ONLY through those opt-in
 * fields. When they're absent, the augment-only contract above holds
 * byte-for-byte. The loop itself lives in `runJudgeRefineLoop` inside
 * yamlRunner.ts; this parser is unchanged and still never gates.
 */

import { redactKnownSecrets } from "../governance/secretValues.js";
import {
  type UntrustedProvenance,
  wrapUntrusted,
} from "../governance/untrustedContent.js";

export type JudgeVerdictKind = "approve" | "request_changes" | "unparseable";

export interface JudgeVerdict {
  verdict: JudgeVerdictKind;
  /** Short bullet points; empty when unparseable. */
  reasons: string[];
  /** Optional fix-list when `verdict: "request_changes"`. */
  fixList?: string[];
  /** Original model text when parsing failed (or for audit). */
  raw?: string;
}

/**
 * Append to the judge prompt to elicit the structured tail. Kept short
 * so it doesn't crowd out the user-provided prompt body.
 */
export const JUDGE_PROMPT_SUFFIX = `

You are a cold-eyes reviewer. Reply with ONLY a single JSON object — no prose,
no markdown fences — of exactly this shape:

{"verdict": "approve" | "request_changes", "reasons": ["..."], "fixList": ["..."]}

Rules:
- "verdict" MUST be exactly "approve" or "request_changes" (lowercase).
- "reasons": short bullet strings explaining the call.
- "fixList": include ONLY when requesting changes; omit it otherwise.
Output nothing except that JSON object.`;

/**
 * Neutralise any sequence that could close the artefact container early.
 *
 * Deliberately local rather than a shared sanitiser: the runtime envelope's
 * equivalent is private to `governance/untrustedContent.ts`, and generalising
 * it would turn a contained fix into a sanitisation refactor. Same technique —
 * a zero-width space after the closing-tag PREFIX, matched case-insensitively,
 * so `</ArTeFaCt>` is caught too. The text stays readable to a model and a
 * human while no longer parsing as the delimiter.
 *
 * Applied in BOTH profiles. The `<artefact>` container exists in compat as
 * well, so making its delimiter unforgeable is correctness of the container,
 * not a governed-profile feature — and ordinary output is untouched, because
 * only content capable of BREAKING the container changes.
 */
function neutraliseArtefactClosingTag(text: string): string {
  return text.replace(/<\/artefact/gi, (m) => `${m}\u200B`);
}

export interface JudgeArtefactOptions {
  /**
   * Present ⇒ mark the artefact as untrusted data from `source`. The caller
   * supplies this only under the governed profile; the envelope is the actual
   * profile distinction, matching how the agent-render path gates its own
   * provenance envelope.
   */
  envelope?: { source: string | UntrustedProvenance };
}

/**
 * Build the artefact-injection block for a judge step that has a
 * `reviews: <stepId>` reference. Returns an empty string when no
 * artefact is available; the judge then sees the prompt as-is.
 *
 * The artefact is the OUTPUT OF AN EARLIER STEP, so it is frequently
 * connector-derived — an email body, a PR description, a page. It used to be
 * interpolated raw: the judge's own prompt went through `renderAgentPrompt`
 * (envelope, provenance, secret redaction) while the thing it was asked to
 * review went through none of it, because this block reads `ctx` directly.
 *
 * Order, and each step is load-bearing:
 *   serialise → secret-VALUE redaction (always) → artefact-tag neutralisation
 *   (always) → untrusted envelope (governed only) → `<artefact>` container.
 */
export function buildJudgeArtefactBlock(
  artefact: unknown,
  opts?: JudgeArtefactOptions,
): string {
  if (artefact === undefined || artefact === null) return "";
  let body: string;
  if (typeof artefact === "string") {
    body = artefact;
  } else {
    try {
      body = JSON.stringify(artefact, null, 2);
      // `JSON.stringify` returns `undefined` for functions / symbols /
      // top-level BigInt — the artefact block becomes
      // `<artefact>\nundefined\n</artefact>` which is misleading. Fall
      // back to a marker so downstream readers can spot the gap.
      if (body === undefined) body = "[unserialisable artefact]";
    } catch {
      // Circular references, BigInt inside the object graph, or any
      // toJSON throwing. The judge step must never propagate this out
      // of the prompt builder — augment-only invariant.
      body = "[unserialisable artefact]";
    }
  }
  // VALUE-based redaction, and it belongs HERE rather than at the call site.
  // The first-pass artefact comes from `ctx` and is redacted by KEY before it
  // arrives; the re-judge artefact is the revised draft, passed explicitly, so
  // it never touches that map. A model that echoes a secret back — quoting a
  // value it was shown, or an error string carrying a token — put it straight
  // into the judge prompt. `registerEnvBlock` already registers declared env
  // values at run start for exactly this case.
  //
  // In the builder, so it covers every caller including future ones, rather
  // than as another runner branch that the next caller can forget.
  body = redactKnownSecrets(body);
  body = neutraliseArtefactClosingTag(body);
  if (opts?.envelope !== undefined) {
    // `wrapUntrusted` neutralises its OWN closing tag, so an artefact cannot
    // forge its way out of either container.
    body = wrapUntrusted(body, opts.envelope.source);
  }
  return `\n\n<artefact>\n${body}\n</artefact>`;
}

/**
 * Walk `text` forward and emit `[start, endInclusive]` ranges for every
 * balanced top-level `{...}` block, respecting JSON string syntax so a
 * `}` inside a string doesn't offset the brace depth.
 *
 * The original implementation walked back from `lastIndexOf("}")` and
 * counted braces literally. A judge response of the shape
 * `Consider this snippet: { x: "} oops" }` would be miscounted — the
 * `}` inside the string would close depth too early and the candidate
 * slice would JSON.parse-fail, returning `unparseable` for an
 * otherwise-legitimate verdict trailer.
 */
function findBalancedObjectRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        ranges.push([start, i]);
        start = -1;
      }
      if (depth < 0) {
        // Stray closing brace — reset so we don't underflow.
        depth = 0;
        start = -1;
      }
    }
  }
  return ranges;
}

/**
 * Normalise a model-supplied verdict value to the canonical enum. Smaller /
 * local models frequently deviate on case, spacing, hyphenation, or tense
 * ("Approved", "request changes", "request-changes") — accepting those instead
 * of failing to `unparseable` cuts judge→refine halts WITHOUT semantic guessing
 * (genuinely ambiguous values still fall through). Conservative on purpose: no
 * "reject"/"pass"/"lgtm" mapping, only spelling/format variants of the two
 * canonical verbs.
 */
function normalizeVerdict(
  raw: unknown,
): "approve" | "request_changes" | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (v === "approve" || v === "approved" || v === "approval") return "approve";
  if (
    v === "request_changes" ||
    v === "request_change" ||
    v === "changes_requested" ||
    v === "needs_changes" ||
    v === "needs_change"
  ) {
    return "request_changes";
  }
  return undefined;
}

/**
 * Parse an agent response into a `JudgeVerdict`. Never throws.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      verdict: "unparseable",
      reasons: [],
      raw: text,
    };
  }

  // Collect every balanced `{...}` range, then try them last-to-first
  // so the JSON tail wins over an in-prose snippet earlier in the
  // response.
  const ranges = findBalancedObjectRanges(trimmed);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    if (!range) continue;
    const [s, e] = range;
    const candidate = trimmed.slice(s, e + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const verdict = normalizeVerdict(obj.verdict);
    if (!verdict) {
      continue;
    }
    const reasons = Array.isArray(obj.reasons)
      ? obj.reasons.filter((r): r is string => typeof r === "string")
      : [];
    const fixList = Array.isArray(obj.fixList)
      ? obj.fixList.filter((r): r is string => typeof r === "string")
      : undefined;
    return {
      verdict,
      reasons,
      ...(fixList && fixList.length > 0 && { fixList }),
    };
  }
  return { verdict: "unparseable", reasons: [], raw: text };
}
