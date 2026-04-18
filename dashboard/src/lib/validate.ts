/**
 * Tiny runtime shape validators for bridge responses.
 *
 * TypeScript interfaces are erased at compile time, so a bridge/dashboard
 * version mismatch (e.g. missing `tools` on /sessions/:id from an older
 * bridge that predates PR #24) silently renders `undefined` in the UI.
 * These helpers turn silent drift into a loud error we can show to users.
 *
 * Keep this dependency-free (no zod/ajv) — the schemas are tiny and the
 * cost of a runtime dep outweighs writing 5-line validators.
 */

export type ShapeError = { path: string; reason: string };

export class ShapeValidationError extends Error {
  constructor(
    public readonly errors: ShapeError[],
    public readonly label: string,
  ) {
    super(
      `${label}: ${errors.map((e) => `${e.path} ${e.reason}`).join("; ")}`,
    );
    this.name = "ShapeValidationError";
  }
}

export type ShapeCheck<T> = (raw: unknown) => T;

/**
 * Assert that a value is a plain object. Useful as the first line of every
 * validator.
 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Build a validator from a label + a pure check function. */
export function shape<T>(
  label: string,
  check: (raw: unknown, errors: ShapeError[]) => T | null,
): ShapeCheck<T> {
  return (raw: unknown): T => {
    const errors: ShapeError[] = [];
    const out = check(raw, errors);
    if (errors.length > 0 || out === null) {
      throw new ShapeValidationError(
        errors.length > 0
          ? errors
          : [{ path: "$", reason: "validator returned null" }],
        label,
      );
    }
    return out;
  };
}

/** Assert a field exists and is a non-empty string. */
export function str(
  obj: Record<string, unknown>,
  field: string,
  errors: ShapeError[],
  opts: { optional?: boolean } = {},
): string | undefined {
  const v = obj[field];
  if (v === undefined) {
    if (!opts.optional) errors.push({ path: field, reason: "missing" });
    return undefined;
  }
  if (typeof v !== "string") {
    errors.push({ path: field, reason: `expected string, got ${typeof v}` });
    return undefined;
  }
  return v;
}

/** Assert a field is a number. */
export function num(
  obj: Record<string, unknown>,
  field: string,
  errors: ShapeError[],
  opts: { optional?: boolean } = {},
): number | undefined {
  const v = obj[field];
  if (v === undefined) {
    if (!opts.optional) errors.push({ path: field, reason: "missing" });
    return undefined;
  }
  if (typeof v !== "number") {
    errors.push({ path: field, reason: `expected number, got ${typeof v}` });
    return undefined;
  }
  return v;
}

/** Assert a field is an array (of anything — caller validates items). */
export function arr<U = unknown>(
  obj: Record<string, unknown>,
  field: string,
  errors: ShapeError[],
  opts: { optional?: boolean } = {},
): U[] | undefined {
  const v = obj[field];
  if (v === undefined) {
    if (!opts.optional) errors.push({ path: field, reason: "missing" });
    return undefined;
  }
  if (!Array.isArray(v)) {
    errors.push({ path: field, reason: `expected array, got ${typeof v}` });
    return undefined;
  }
  return v as U[];
}
