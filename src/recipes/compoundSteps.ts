/**
 * Compound steps on the FLAT runner (`yamlRunner`).
 *
 * `dispatchRecipe` routes on `trigger.type === "chained"` alone, so every
 * cron / manual / event / webhook recipe runs on the flat runner — which
 * reads none of the compound forms. Such a step used to fall through to
 * executeToolStep's "Unknown tool — skip, don't throw (forward compat)"
 * return, come back `null`, and be recorded as `status: "skipped"` with no
 * error: the run reported success while the step body never executed. Eight
 * recipes shipped in this repo were inert that way, including two the
 * `recipe lint` CI gates asserted were valid.
 *
 * Two different answers, because the forms differ in kind:
 *
 *   `parallel: [a, b, c]` — a scheduling HINT. The flat runner executes steps
 *   sequentially, and running a, b, c in order produces the same results as
 *   running them at once; only wall-clock differs. So it is desugared
 *   (`expandFlatParallel`) rather than rejected — the recipes start working.
 *
 *   `each` / `parallel: {each}` / `recipe` / `chain` / `branch` — these change
 *   WHICH steps run and how many times. There is no sequential equivalent to
 *   fall back on, so they fail loud (`UNSUPPORTED_STEP_KEYS`).
 *
 * An unrecognised tool NAME is a third case and keeps its deliberate skip: a
 * recipe naming a plugin tool while the plugin is un-loaded must not kill the
 * run (see the "skips unknown tools without throwing" test).
 *
 * Shared by `validation.ts` (lint: `recipe lint` / `recipe doctor` / the
 * dashboard install panel) and `yamlRunner.ts` (runtime) so authoring-time and
 * run-time verdicts cannot drift — that drift is the failure this module
 * exists to close.
 *
 * `awaits` is deliberately absent from the unsupported set: sequential
 * execution is a valid schedule for any ordering hint, so ignoring it loses
 * nothing and erroring on it would be a false alarm.
 */

/** Forms with no sequential equivalent — always an error on the flat runner. */
export const UNSUPPORTED_STEP_KEYS = [
  "each",
  "recipe",
  "chain",
  "branch",
] as const;

export type UnsupportedStepKey = (typeof UNSUPPORTED_STEP_KEYS)[number];

/**
 * Group-level keys `expandFlatParallel` knows how to carry down to children.
 * Anything else on a `parallel:` group is REJECTED rather than dropped — a
 * silently-ignored group-level field is the same bug class this module fixes,
 * one level down. Survey of every `parallel:` group shipped in this repo and
 * installed locally: only `id` and `risk` occur in practice.
 */
const PROPAGATABLE_GROUP_KEYS = new Set(["id", "risk", "when", "parallel"]);

/**
 * Unsupported compound keys on a raw (unparsed) step, in a stable order.
 * Object-form `parallel: {each}` counts — only the ARRAY form is desugarable.
 */
export function unsupportedKeysOf(step: unknown): string[] {
  if (!step || typeof step !== "object" || Array.isArray(step)) return [];
  const rec = step as Record<string, unknown>;
  const keys: string[] = UNSUPPORTED_STEP_KEYS.filter(
    (k) => rec[k] !== undefined,
  );
  if (
    rec.parallel !== undefined &&
    !Array.isArray(rec.parallel) &&
    typeof rec.parallel === "object" &&
    rec.parallel !== null
  ) {
    keys.unshift("parallel:{each}");
  }
  return keys;
}

/**
 * The one sentence both paths emit. Shared so the runtime `haltReason`, the
 * lint message, and `categoriseHaltReason`'s `unsupported_step` pattern
 * ("is not supported in this recipe") stay in sync.
 *
 * The remedy is per-construct on purpose. "Set `trigger.type: chained`" is
 * right for `recipe:` / `chain:` (the chained runner implements those) and
 * WRONG for `each` (it rejects that form too) and for `branch:` (no runner
 * has ever implemented it). Sending an author to a second path that also
 * fails is the same class of misdirection this module exists to remove.
 */
const REMEDY: Record<string, string> = {
  each: "Use the `fan_out` tool step — no runner implements `each`.",
  "parallel:{each}":
    "Use the `fan_out` tool step — no runner implements the map-reduce form.",
  recipe: "Set `trigger.type: chained`, which supports nested recipes.",
  chain: "Set `trigger.type: chained`, which supports chained sub-recipes.",
  branch:
    "Rewrite as `when:`-guarded steps — `branch:` is not implemented in any runner.",
};

export function unsupportedStepMessage(
  where: string,
  keys: readonly string[],
): string {
  const remedies = [...new Set(keys.map((k) => REMEDY[k]).filter(Boolean))];
  return (
    `${where} uses \`${keys.join(", ")}\`, which is not supported in this recipe. ` +
    remedies.join(" ")
  );
}

/**
 * Desugar `parallel: [ ... ]` groups into sequential steps, recursively.
 *
 * Children inherit the group's `risk` and `when` when they don't set their
 * own. A group and a child BOTH setting `when` throws: the correct semantics
 * is "group guard AND child guard", and two templates cannot be conjoined
 * without an expression evaluator the flat renderer doesn't have. Throwing
 * beats picking one and silently discarding the other.
 *
 * Throws on an unknown group-level key for the same reason.
 */
export function expandFlatParallel<T>(steps: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      if (step !== undefined) out.push(step);
      continue;
    }
    const rec = step as unknown as Record<string, unknown>;
    if (!Array.isArray(rec.parallel)) {
      out.push(step);
      continue;
    }

    const groupId = typeof rec.id === "string" ? rec.id : `parallel_${i}`;
    const unknownKeys = Object.keys(rec).filter(
      (k) => !PROPAGATABLE_GROUP_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `parallel group "${groupId}" sets \`${unknownKeys.join(", ")}\`, which is not carried to its steps. ` +
          "Move the field onto the individual steps inside the group.",
      );
    }

    const children: unknown[] = [];
    for (const rawChild of rec.parallel) {
      if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild))
        continue;
      const child = { ...(rawChild as Record<string, unknown>) };
      if (rec.when !== undefined) {
        if (child.when !== undefined) {
          throw new Error(
            `parallel group "${groupId}" and its step "${String(child.id ?? child.tool ?? "?")}" both set \`when\` — ` +
              "the flat runner cannot combine two guards. Put the condition on one of them.",
          );
        }
        child.when = rec.when;
      }
      if (rec.risk !== undefined && child.risk === undefined)
        child.risk = rec.risk;
      children.push(child);
    }
    // Recurse so a nested `parallel:` inside a group is flattened too.
    out.push(...expandFlatParallel(children as readonly T[]));
  }
  return out;
}
