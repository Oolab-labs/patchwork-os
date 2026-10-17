/**
 * Withheld step outputs — a run handed operator material keeps its answers
 * out of the run records.
 *
 * A `type: text` input (and a `type: file` input, once that type exists) is
 * held by the value-redaction layer, so the VALUE never reaches a ledger
 * (`textInputs.ts`). What redaction cannot catch is everything DERIVED from
 * it: an agent asked to organise pasted notes answers by quoting them line by
 * line, and that answer is exactly what the flight recorder captures — on the
 * step row, in `run_steps.jsonl`, and as the `outputTail` of the orchestrator
 * task that served the agent step. The answer has already gone to its real
 * destination (an inbox note, a message), so the run log does not need it.
 *
 * So for a run that USES such an input — declared with that type AND given a
 * value or a default in this run — no step output is captured at all. Each
 * step that produced something records an explicit marker instead:
 *
 *   outputWithheld: { reason: "text_or_file_input", length, sha256 }
 *
 * Never a silent absence: a reader must be able to tell "withheld" from
 * "nothing was produced", which is why replay refuses such a run by name
 * (`replay_unavailable_outputs_withheld`) instead of reporting an unmocked
 * step.
 *
 * Scope is the whole run, every step, not only those whose params reference
 * the input. Tracking which outputs DERIVE from the input would have to follow
 * values through `transform`, JSON-parsed fields and nested recipes, and a
 * miss there is a silent leak; withholding the run is the boundary that
 * cannot be wrong in that direction.
 *
 * Runs without such an input are untouched, byte for byte.
 */

import { createHash } from "node:crypto";

/** The one reason a step output is withheld today. */
export const OUTPUT_WITHHELD_REASON = "text_or_file_input" as const;
export type OutputWithheldReason = typeof OUTPUT_WITHHELD_REASON;

/** What a run record carries in place of a withheld output. */
export interface OutputWithheld {
  reason: OutputWithheldReason;
  /** Length of the withheld value in UTF-16 code units (`String.length`). */
  length: number;
  /** sha256 (hex) of the withheld value's UTF-8 bytes. */
  sha256: string;
}

/** Replay refusal code for a run whose outputs were withheld. */
export const REPLAY_UNAVAILABLE_OUTPUTS_WITHHELD =
  "replay_unavailable_outputs_withheld";

/**
 * Input types whose values are operator material. Matched on the RAW declared
 * `type` rather than through `declaredTriggerInputs`, which reports only the
 * types it validates — a newer type must be covered the moment a recipe can
 * declare it, not when that reader learns about it.
 */
const PROTECTED_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "file"]);

interface DeclaredProtectedInput {
  name: string;
  hasDefault: boolean;
}

function protectedInputsOf(recipe: unknown): DeclaredProtectedInput[] {
  const trigger = (recipe as { trigger?: unknown } | null | undefined)
    ?.trigger as Record<string, unknown> | null | undefined;
  if (!trigger || typeof trigger !== "object") return [];
  const protectedNames = new Set<string>();
  const withDefault = new Set<string>();
  for (const key of ["inputs", "vars"] as const) {
    const arr = trigger[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || rec.name.length === 0) continue;
      // Any entry for a name declaring a protected type protects the name —
      // over-reporting here can only withhold, never leak.
      if (typeof rec.type === "string" && PROTECTED_INPUT_TYPES.has(rec.type)) {
        protectedNames.add(rec.name);
      }
      if (
        rec.default !== undefined &&
        rec.default !== null &&
        String(rec.default).length > 0
      ) {
        withDefault.add(rec.name);
      }
    }
  }
  return [...protectedNames].map((name) => ({
    name,
    hasDefault: withDefault.has(name),
  }));
}

function isSupplied(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  return true;
}

/**
 * Does this run withhold its step outputs? True when the recipe declares a
 * `text` or `file` input AND this run has a value for it — supplied, or a
 * declared default.
 */
export function runWithholdsOutputs(
  recipe: unknown,
  values: Record<string, unknown> | undefined,
): boolean {
  for (const input of protectedInputsOf(recipe)) {
    if (input.hasDefault) return true;
    if (values && Object.hasOwn(values, input.name)) {
      if (isSupplied(values[input.name])) return true;
    }
  }
  return false;
}

/** The marker recorded in place of `value`. */
export function outputWithheldMarker(value: unknown): OutputWithheld {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return {
    reason: OUTPUT_WITHHELD_REASON,
    length: text.length,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

/** Ids of the steps of a recorded run whose outputs were withheld. */
export function withheldStepIds(run: {
  stepResults?: ReadonlyArray<{ id: string; outputWithheld?: unknown }>;
}): string[] {
  const ids: string[] = [];
  for (const s of run.stepResults ?? []) {
    if (s.outputWithheld !== undefined) ids.push(s.id);
  }
  return ids;
}

/** The replay refusal message for a run with withheld outputs. */
export function replayWithheldMessage(stepIds: readonly string[]): string {
  return (
    `${REPLAY_UNAVAILABLE_OUTPUTS_WITHHELD}: this run used a text or file ` +
    `input, so its step outputs were not recorded (${stepIds.join(", ")}). ` +
    "Mocked replay has no evidence to replay from; nothing was dispatched."
  );
}

// ---------------------------------------------------------------------------
// Assertion failures and judge verdicts
// ---------------------------------------------------------------------------
//
// Two channels carry ANSWER TEXT without being a step output, so withholding
// step outputs did not reach them:
//
// - A completion-contract (`expect`) failure records the `actual` value that
//   failed, and its message quotes it. When the checked value is the model's
//   answer, that is the operator's material again.
// - A judge verdict carries free-text `reasons`, a `fixList`, and, when the
//   reply did not parse, the `raw` model text — all of which can quote the
//   artefact under review.
//
// In a protected run the STRUCTURE survives (assertion id, the
// recipe-authored `expected`, the verdict kind) and the text is replaced by
// the same marker shape as a withheld output. Runs without such an input are
// untouched.

/** The fields of a run-level assertion failure this module rewrites. */
export interface WithheldAssertionFields {
  assertion: string;
  expected: unknown;
  actual?: unknown;
  /** Present instead of `actual` when the run withheld its outputs. */
  actualWithheld?: OutputWithheld;
  message: string;
}

/**
 * Replace each failure's `actual` (and the message that quotes it) with a
 * marker. A failure whose `actual` is `undefined` — a missing key — quotes
 * nothing and is returned unchanged.
 */
export function withholdAssertionFailures<T extends WithheldAssertionFields>(
  failures: readonly T[],
): T[] {
  return failures.map((f) => {
    if (f.actual === undefined) return f;
    const { actual, ...rest } = f;
    return {
      ...rest,
      actualWithheld: outputWithheldMarker(actual),
      message:
        `${f.assertion}: actual value withheld (run used a text or file ` +
        `input); expected ${JSON.stringify(f.expected)}`,
    } as T;
  });
}

/**
 * What a step-level `expect` message says in place of the value it would
 * otherwise quote.
 */
export function withheldValueNote(value: string): string {
  const m = outputWithheldMarker(value);
  return (
    "a value withheld (run used a text or file input; " +
    `length ${m.length}, sha256 ${m.sha256.slice(0, 12)})`
  );
}

/** The free-text-bearing shape of a judge verdict. */
interface JudgeVerdictLike {
  verdict: string;
  reasons: string[];
  fixList?: string[];
  raw?: string;
  textWithheld?: OutputWithheld;
}

/**
 * Keep the verdict kind; replace `reasons`, `fixList` and `raw` with one
 * marker over exactly the text removed.
 */
export function withholdJudgeVerdict<T extends JudgeVerdictLike>(v: T): T {
  if (v.textWithheld !== undefined) return v;
  const { reasons, fixList, raw, ...rest } = v;
  const removed = {
    reasons,
    ...(fixList !== undefined && { fixList }),
    ...(raw !== undefined && { raw }),
  };
  return {
    ...rest,
    reasons: [],
    textWithheld: outputWithheldMarker(removed),
  } as unknown as T;
}
