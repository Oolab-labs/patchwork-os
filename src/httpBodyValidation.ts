/**
 * Strict allow-list validation for HTTP request body keys.
 *
 * `readJsonBody<T>()` is type-erased at runtime — the generic only documents
 * the EXPECTED shape; unknown top-level keys are silently kept on the parsed
 * object and dropped by the handler's destructure. Misspelled fields
 * (`enabledZ`, `targerName`, `vasr`) succeed as a no-op + 200, which masks
 * client bugs and complicates dashboard debugging.
 *
 * This helper closes the silent-failure gap for the highest-value
 * configuration endpoints (settings, telemetry, kill-switch, recipe run /
 * promote / trust). Callers extract the body, run this check, and on
 * failure return a 400 enumerating the unknown keys.
 *
 * Sister module to `httpErrorResponse.ts`; same one-function-one-file style.
 */
import type { ServerResponse } from "node:http";

export type AllowedKeysResult =
  | { ok: true }
  | { ok: false; unknownKeys: string[] };

/**
 * Returns `{ok: true}` when every own enumerable key on `body` is in
 * `allowed`. Otherwise lists the offending keys.
 *
 * Uses `Object.hasOwn` to avoid prototype walk surface (see project memory
 * `feedback_record_string_prototype_walk.md` — 5 prod sites burned by
 * `key in obj` / bare bracket access on attacker-controlled objects).
 *
 * Non-object / null / array bodies short-circuit `{ok: true}` — the
 * handler's own shape-check will reject them with its existing 400.
 */
export function validateAllowedBodyKeys(
  body: unknown,
  allowed: readonly string[],
): AllowedKeysResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: true };
  }
  const allowSet = new Set(allowed);
  const unknownKeys: string[] = [];
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!Object.hasOwn(body as object, key)) continue;
    if (!allowSet.has(key)) unknownKeys.push(key);
  }
  if (unknownKeys.length > 0) {
    return { ok: false, unknownKeys };
  }
  return { ok: true };
}

/**
 * Convenience: writes the canonical 400 response and returns true when the
 * body fails the allow-list check. Returns false on success so callers can
 * `if (respondIfUnknownBodyKeys(...)) return;` and keep flowing.
 */
export function respondIfUnknownBodyKeys(
  res: ServerResponse,
  body: unknown,
  allowed: readonly string[],
): boolean {
  const result = validateAllowedBodyKeys(body, allowed);
  if (result.ok) return false;
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "Unknown body fields",
      unknownKeys: result.unknownKeys,
    }),
  );
  return true;
}
