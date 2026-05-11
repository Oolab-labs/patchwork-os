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
 */

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

You are a cold-eyes reviewer. Respond with a brief assessment, then end
with a single JSON object on its own line:

{"verdict": "approve" | "request_changes", "reasons": ["..."], "fixList": ["..."]}

The "fixList" is optional and only relevant when requesting changes.
Output only the JSON object as the final line.`;

/**
 * Build the artefact-injection block for a judge step that has a
 * `reviews: <stepId>` reference. Returns an empty string when no
 * artefact is available; the judge then sees the prompt as-is.
 */
export function buildJudgeArtefactBlock(artefact: unknown): string {
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
    const verdictRaw = obj.verdict;
    if (verdictRaw !== "approve" && verdictRaw !== "request_changes") {
      continue;
    }
    const reasons = Array.isArray(obj.reasons)
      ? obj.reasons.filter((r): r is string => typeof r === "string")
      : [];
    const fixList = Array.isArray(obj.fixList)
      ? obj.fixList.filter((r): r is string => typeof r === "string")
      : undefined;
    return {
      verdict: verdictRaw,
      reasons,
      ...(fixList && fixList.length > 0 && { fixList }),
    };
  }
  return { verdict: "unparseable", reasons: [], raw: text };
}
