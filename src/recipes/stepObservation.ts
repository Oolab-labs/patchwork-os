/**
 * stepObservation — observability shims for recipe step execution.
 *
 * Bundles two independent concerns that both wrap step output for the
 * runner / runlog / dashboard. They live together because they're both
 * "what the runtime sees of a step's result," not because they share
 * data — the two functions don't call each other and don't share types.
 *
 *   1. detectSilentFail(result) — recognize tool-output strings or shapes
 *      that indicate a tool silently failed but reported "success" to
 *      the runner. Used by yamlRunner to flag steps as `error` even when
 *      the tool returned `ok:true`. Per-step opt-out via
 *      `silentFailDetection: false`.
 *
 *   2. captureForRunlog(value) — sanitize + cap a step value for
 *      persistence. Redacts known sensitive keys, handles cycles /
 *      BigInt / undefined, and truncates JSON over 8 KB with a clear
 *      `[truncated]` marker. Used by chainedRunner + approvalHttp.
 *
 * Both replace the previous `detectSilentFail.ts` and `captureForRunlog.ts`
 * files (issue #252). Behavior is unchanged — the merge is organizational.
 */

// ---------------------------------------------------------------------------
// detectSilentFail
//
// Background: yamlRunner originally only flagged a step as `error` when
// the tool's JSON return had `ok: false`. Tools returning string
// placeholders (`(git branches unavailable)`, `[agent step skipped:
// ANTHROPIC_API_KEY not set]`) succeeded as far as the runner was
// concerned — the failure was silent until a downstream agent
// regurgitated "data unavailable" in its output. The post-merge dogfood
// (`branch-health` recipe via Playwright) caught two distinct bugs of
// this class:
//   1. `git.stale_branches` was using an invalid `git branch --since=`
//      flag, ALWAYS returning `(git branches unavailable)` (PR #70).
//   2. `agentExecutor` returns `[agent step skipped: ANTHROPIC_API_KEY
//      not set]` when the API key is absent — the recipe completes
//      with `status:ok` and that string written to disk.
// ---------------------------------------------------------------------------

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
const SILENT_FAIL_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
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
  // Typed reason: recipe step ran with no workspace root resolved. Emitted
  // by `defaultClaudeCodeFn` when `resolveWorkspaceRoot()` returns null —
  // first fix in the halt-taxonomy refinement (P7 of the 2026-05-20
  // research run). MUST match before the generic agent-step pattern below
  // so the typed reason isn't swallowed by the catch-all.
  {
    regex: /^\s*\[agent step failed:\s*recipe_no_workspace\b/i,
    reason: "recipe_no_workspace",
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
    for (const { regex, reason } of SILENT_FAIL_PATTERNS) {
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

// ---------------------------------------------------------------------------
// captureForRunlog
//
// VD-2 captures `resolvedParams`, `output`, and `registrySnapshot` per step
// so the dashboard can show diff hovers + replay. These can carry secrets
// (auth headers, API keys, passwords) and arbitrary user data, so we:
//
//   1. Redact known sensitive keys before serialization.
//   2. JSON-stringify defensively (handle cycles, BigInt, undefined).
//   3. Cap the JSON-encoded form at MAX_BYTES. Larger values are
//      truncated with a clear `[truncated]` marker so the dashboard can
//      tell users the value didn't fit, rather than guessing why it's
//      missing.
//
// Bytes are JSON-string bytes, not the in-memory size — safe upper bound
// since serialization is what the runlog persists.
// ---------------------------------------------------------------------------

const MAX_BYTES = 8 * 1024;

// Case-insensitive substring match. Order: most specific first to avoid
// accidentally matching narrower strings (none currently overlap, but
// this is the convention).
const SENSITIVE_KEY_PATTERNS = [
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "session",
  "private-key",
  "privatekey",
  "client-secret",
  "client_secret",
  "refresh-token",
  "refresh_token",
  "access-token",
  "access_token",
];

export const REDACTED = "[REDACTED]";
const TRUNCATED = "[truncated]";

/**
 * Build a context copy in which the values of `secretKeys` (keys populated
 * from a recipe-level `type: env` block) are replaced with the REDACTED
 * marker. Used to render the LLM-facing agent prompt so an env-sourced
 * secret never reaches the model verbatim. Tool-step param interpolation
 * uses the ORIGINAL context — tools legitimately need the real value.
 *
 * Returns the input unchanged (same reference) when there are no secret
 * keys, so the common no-secrets recipe path allocates nothing.
 */
export function redactSecretsForPrompt<T extends Record<string, string>>(
  ctx: T,
  secretKeys: ReadonlySet<string>,
): T {
  if (secretKeys.size === 0) return ctx;
  const out: Record<string, string> = { ...ctx };
  for (const key of secretKeys) {
    if (Object.hasOwn(out, key)) out[key] = REDACTED;
  }
  return out as T;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

/**
 * Walk a value and replace any property whose key matches a sensitive
 * pattern. Arrays + nested objects walked recursively. Cycles handled by
 * tracking seen objects. Non-objects pass through unchanged.
 */
function redactSensitive(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactSensitive(v, seen);
    }
  }
  return out;
}

/**
 * Capture a value for inclusion in `RunStepResult`. Returns undefined if
 * the value is `undefined` (don't bloat the log row for steps that
 * produced nothing).
 *
 * Throws nothing — sanitize/serialize errors are caught and replaced with
 * a small placeholder so a malformed step output never breaks the log
 * write.
 */
export function captureForRunlog(value: unknown): unknown | undefined {
  if (value === undefined) return undefined;
  let redacted: unknown;
  try {
    redacted = redactSensitive(value);
  } catch {
    return { error: "[capture-redact-failed]" };
  }

  let json: string;
  try {
    json = JSON.stringify(redacted, (_key, v) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return "[function]";
      if (typeof v === "symbol") return v.toString();
      return v;
    });
  } catch {
    return { error: "[capture-serialize-failed]" };
  }
  // JSON.stringify returns undefined for certain top-level values (e.g.
  // bare `undefined`). Already excluded above, but guard for safety.
  if (typeof json !== "string") return undefined;

  if (Buffer.byteLength(json, "utf8") <= MAX_BYTES) {
    return redacted;
  }

  // Over the cap. Don't try to walk + trim — that gets messy fast. Just
  // slice the JSON string to the budget and reattach a clear marker.
  // Re-parse may fail (we cut mid-key); if so, return a string envelope.
  const slice = json.slice(0, MAX_BYTES);
  return {
    [TRUNCATED]: true,
    bytes: Buffer.byteLength(json, "utf8"),
    preview: slice,
  };
}
