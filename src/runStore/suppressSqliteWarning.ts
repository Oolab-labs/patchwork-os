/**
 * Silence Node's `ExperimentalWarning` for `node:sqlite` — and nothing else.
 *
 * ## Why it wraps `process.emitWarning` rather than listening for warnings
 *
 * The obvious implementation — `process.on("warning", …)` and return early for
 * the one you want gone — DOES NOT WORK, and fails in the worst direction.
 * Node prints warnings from its own internal handler regardless of how many
 * listeners are attached; a listener observes, it does not intercept. The
 * first version of this file assumed otherwise, suppressed nothing, and
 * re-printed every unrelated warning a second time. Its own test caught it.
 *
 * Wrapping `emitWarning` works because Node routes experimental notices
 * through it, so declining to delegate genuinely stops the warning at source.
 *
 * ## Why it is a function you CALL, not an import side effect
 *
 * This mutates global process state. A leaf module doing that on import would
 * change behaviour for anyone who happened to import it, including code that
 * never asked. The decision belongs at an entry point.
 *
 * ## Why suppress at all
 *
 * ADR-0022 puts `node:sqlite` in the trust-evidence path and accepted its
 * experimental status as a known risk. The warning fires once per process,
 * says nothing an operator can act on, and lands in `bridge.err` beside real
 * incidents — and a log carrying a permanent unexplained warning trains people
 * to skim it. Same reasoning that removed the permanently-red CI cell (#1369).
 *
 * The RISK, stated rather than buried: if Node ever gives an
 * ExperimentalWarning mentioning SQLite a different meaning — a deprecation, a
 * behaviour change — this hides it. Scoped as narrowly as the text allows, and
 * it is one call to delete once `node:sqlite` is stable.
 */

type EmitWarning = typeof process.emitWarning;

let original: EmitWarning | null = null;

function isSqliteExperimental(message: string, type: string | undefined) {
  return type === "ExperimentalWarning" && /\bSQLite\b/i.test(message);
}

/**
 * Install the filter. Idempotent — safe to call from more than one entry
 * point. Wrapping twice would build a chain that still works but is harder to
 * unwind, so the second call is a no-op.
 */
export function suppressSqliteExperimentalWarning(): void {
  if (original) return;
  original = process.emitWarning.bind(process);
  const delegate = original;

  process.emitWarning = ((
    warning: string | Error,
    ...rest: unknown[]
  ): void => {
    // `emitWarning` has several overloads: (msg, type), (msg, options),
    // (err). Read the type defensively rather than assuming one shape — a
    // wrong guess here would either leak the warning or, far worse, swallow
    // unrelated ones.
    const first = rest[0];
    const type =
      typeof first === "string"
        ? first
        : typeof first === "object" && first !== null
          ? (first as { type?: string }).type
          : warning instanceof Error
            ? warning.name
            : undefined;
    const message =
      typeof warning === "string" ? warning : (warning?.message ?? "");

    if (isSqliteExperimental(message, type)) return;
    (delegate as (...a: unknown[]) => void)(warning, ...rest);
  }) as EmitWarning;
}

/** Restore Node's original behaviour. Test seam, and an escape hatch. */
export function restoreWarnings(): void {
  if (!original) return;
  process.emitWarning = original;
  original = null;
}
