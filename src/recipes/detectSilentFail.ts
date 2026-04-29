/**
 * detectSilentFail — recognize tool-output strings that indicate a tool
 * silently failed but reported "success" to the runner.
 *
 * Background: yamlRunner originally only flagged a step as `error` when
 * the tool's JSON return had `ok: false`. Tools returning string
 * placeholders (`(git branches unavailable)`, `[agent step skipped:
 * ANTHROPIC_API_KEY not set]`) succeeded as far as the runner was
 * concerned — the failure was silent until a downstream agent
 * regurgitated "data unavailable" in its output. The post-merge dogfood
 * (`branch-health` recipe via Playwright) caught two distinct bugs of
 * this class:
 *   1. `git.stale_branches` was using an invalid `git branch --since=`
 *      flag, ALWAYS returning `(git branches unavailable)` (PR #70).
 *   2. `agentExecutor` returns `[agent step skipped: ANTHROPIC_API_KEY
 *      not set]` when the API key is absent — the recipe completes
 *      with `status:ok` and that string written to disk.
 *
 * This module gives the runner a way to detect those patterns and flag
 * the step as `error`. Default-on; recipes can opt out per-step via
 * `silentFailDetection: false`.
 */

export interface SilentFailMatch {
  reason: string;
  /** Slice of the result that triggered the match (for the error msg). */
  matched: string;
}

/**
 * Patterns that indicate a tool silently failed.
 *
 * The patterns are intentionally narrow — string-typed tool outputs are
 * a rich surface and we don't want false positives. Each pattern
 * corresponds to a known antipattern caught in the wild; bare prose is
 * NOT flagged.
 */
const PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  // Placeholder strings emitted by `defaultGitLogSince`,
  // `defaultGitStaleBranches` (pre-PR-70), and similar tools that
  // catch all errors and return a parens-wrapped "unavailable" string.
  // Match: anywhere on a single line, parens around a phrase containing
  // "unavailable" / "not available" / "not configured" / "error" /
  // "failed" — any of those wrapped in parens at the start of the line
  // is a strong signal.
  {
    regex:
      /^\s*\(([^()]*?)(unavailable|not available|not configured|no data|error|failed)\)/i,
    reason: "tool returned a parens-wrapped placeholder",
  },
  // Agent-step short-circuit: agentExecutor's own error/skip strings.
  // Used by `executeAgent` when an API key is missing or the LLM
  // returns nothing. Not surfaced as JSON, so the runner never saw it.
  {
    regex: /^\s*\[agent step (skipped|failed):/i,
    reason: "agent step skipped or failed (string placeholder)",
  },
  // Generic step-skipped marker in case more callers adopt it.
  {
    regex: /^\s*\[step (skipped|failed):/i,
    reason: "step skipped or failed (string placeholder)",
  },
];

/**
 * Returns a `SilentFailMatch` if `result` looks like a silent-fail
 * placeholder, else `null`. JSON `{ok:false}` detection stays in the
 * runner — this module only handles the string + JSON-shape patterns
 * the runner doesn't already catch.
 */
export function detectSilentFail(result: unknown): SilentFailMatch | null {
  if (result === null || result === undefined) return null;

  if (typeof result === "string") {
    for (const { regex, reason } of PATTERNS) {
      const m = regex.exec(result);
      if (m) {
        // Cap the matched fragment so error messages stay readable.
        const matched = m[0].slice(0, 120);
        return { reason, matched };
      }
    }
    // String result that LOOKS like JSON — try parsing and recursing.
    if (result.startsWith("{") || result.startsWith("[")) {
      try {
        return detectSilentFail(JSON.parse(result));
      } catch {
        return null;
      }
    }
    return null;
  }

  if (typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    // List-tool antipattern: `{count: 0, error: "..."}`. Tools that
    // catch errors and return an empty list with an `error` field
    // succeed-with-zero from the runner's view. Specifically targets
    // `github.listIssues`, `linear.listIssues`, etc. flagged in the
    // tool audit.
    if (
      typeof obj.error === "string" &&
      obj.error.length > 0 &&
      (obj.count === 0 ||
        (Array.isArray(obj.items) && obj.items.length === 0) ||
        (Array.isArray(obj.results) && obj.results.length === 0))
    ) {
      return {
        reason: "list-tool returned empty with error field",
        matched: obj.error.slice(0, 120),
      };
    }
  }

  return null;
}
