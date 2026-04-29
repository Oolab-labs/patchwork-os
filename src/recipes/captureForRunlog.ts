/**
 * captureForRunlog — sanitize + cap recipe step values for the run log.
 *
 * VD-2 captures `resolvedParams`, `output`, and `registrySnapshot` per step
 * so the dashboard can show diff hovers + replay. These can carry secrets
 * (auth headers, API keys, passwords) and arbitrary user data, so we:
 *
 *   1. Redact known sensitive keys before serialization.
 *   2. JSON-stringify defensively (handle cycles, BigInt, undefined).
 *   3. Cap the JSON-encoded form at `MAX_BYTES`. Larger values are
 *      truncated with a clear `[truncated]` marker so the dashboard can
 *      tell users the value didn't fit, rather than guessing why it's
 *      missing.
 *
 * Bytes are JSON-string bytes, not the in-memory size — safe upper bound
 * since serialization is what the runlog persists.
 */

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

const REDACTED = "[REDACTED]";
const TRUNCATED = "[truncated]";

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
