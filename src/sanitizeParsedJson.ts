/**
 * Recursively strip prototype-pollution keys from a `JSON.parse` result
 * before it lands in a shared map / merge target / runtime context.
 *
 * Why this is needed even though `JSON.parse` doesn't mutate
 * `Object.prototype`:
 *   V8 uses `Object.defineProperty(obj, "__proto__", { value, ... })` for
 *   `JSON.parse('{"__proto__": {...}}')`, so the prototype chain itself
 *   is unaffected at parse time. But the *own property* survives — and
 *   any downstream `Object.assign(target, parsed)`, deep-merge, spread,
 *   or `for...in` traversal that writes via bracket assignment will
 *   re-introduce the pollution.
 *
 * The conservative move at every untrusted-JSON ingest boundary is to
 * walk the parse result and drop the three dangerous keys
 * (`__proto__`, `constructor`, `prototype`) recursively.
 *
 * See PR #568 + `feedback_record_string_prototype_walk.md` for the
 * underlying class of bugs. Originally local to
 * `src/recipes/yamlRunner.ts`; this module is the shared home.
 */

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Strip `__proto__` / `constructor` / `prototype` own-property keys
 * recursively from `value`. Returns a plain JSON-safe shape (objects
 * become `Record<string, unknown>` with the dangerous keys absent;
 * arrays mapped element-wise; primitives returned as-is).
 *
 * This is a clone, not an in-place mutation. The original parse result
 * is left untouched, so callers can apply this lazily and the eager
 * shape (e.g. when the parse result is also used for fast-path
 * comparison) still sees the original.
 */
export function sanitizeParsedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeParsedJson);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = sanitizeParsedJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * `JSON.parse` + `sanitizeParsedJson` in one call. Use at any
 * untrusted-JSON ingest site (agent step output, plugin manifest,
 * automation policy from disk, connector tokens after store-fetch).
 */
export function parseJsonSanitized(raw: string): unknown {
  return sanitizeParsedJson(JSON.parse(raw));
}
