/**
 * Where an ADR-0021 `data_policy` may be declared, and where it is read.
 *
 * ## The failure this closes
 *
 * `data_policy` must be nested INSIDE `agent:` on an agent step — that is what
 * `yamlRunner` reads (`agentCfg.data_policy`) and what ADR-0021's example
 * shows. Declared one level up, as a sibling of `agent:`, it was **silently
 * ignored**: `recipe lint` reported `✓ Valid recipe (0 warnings)`, the run
 * succeeded, and the boundary row came out `labelSource: "assumed"` —
 * indistinguishable from a step that declared nothing at all.
 *
 * Observed, not theorised: declared at step level on two real recipes, both
 * linted clean, ran one, and all four resulting rows were `assumed`. Moving the
 * block inside `agent:` produced `declared` on the same step.
 *
 * ## Why this one deserves an error rather than a warning
 *
 * The thing being silently dropped is a SAFETY declaration, and the two mental
 * models disagree in the direction that permits: the author believes the step
 * is labelled `confidential`; the runtime believes it declared nothing and
 * defaults it to `internal`.
 *
 * It is also the field where being wrong is invisible in the output. An ignored
 * `prompt` or `driver` changes what the step does and you notice within
 * seconds. An ignored `data_policy` changes only a row in a ledger nobody reads
 * until an audit — which is precisely when it is too late to notice.
 *
 * ## The precedent this follows
 *
 * `compoundSteps.ts` exists because a compound step on the flat runner passed
 * lint AND reported a successful run whose body never executed. Its header
 * states the principle: lint and runtime are shared so "authoring-time and
 * run-time verdicts cannot drift — that drift is the failure this module exists
 * to close."
 *
 * This is that same drift, on the privacy surface.
 *
 * ## And the contrast that makes it clearly a bug
 *
 * The SAME misplacement one level deeper already fails loudly: `fan_out`
 * refuses `do.agent.data_policy` with an explicit error, because its allowlist
 * treats an unrecognised agent option as a potential false safety signal. So
 * the codebase already considers a misplaced `data_policy` worth refusing —
 * just not in this position. Two placements, one author error, opposite
 * handling.
 */

/** Steps whose tool reads a step-level `data_policy`. */
const TOOLS_THAT_READ_STEP_LEVEL_POLICY = new Set(["fan_out"]);

export interface MisplacedDataPolicy {
  /** Why it is wrong here, and where it belongs. */
  message: string;
  /** Dotted path for the lint issue. */
  key: "data_policy";
}

/**
 * Report a `data_policy` declared where nothing will read it.
 *
 * Returns `null` when the placement is fine, which is the common case:
 *
 *   - inside `agent:` on an agent step — read by `yamlRunner`;
 *   - on a `fan_out` step — read by the tool and applied to every iteration
 *     (#1466). The classification describes the batch, so it is declared once
 *     on the step rather than per item.
 *
 * Everything else is a step-level `data_policy` no code path consults.
 */
export function misplacedDataPolicy(step: unknown): MisplacedDataPolicy | null {
  if (!step || typeof step !== "object" || Array.isArray(step)) return null;
  const rec = step as Record<string, unknown>;
  if (rec.data_policy === undefined) return null;

  const tool = typeof rec.tool === "string" ? rec.tool : undefined;
  if (tool && TOOLS_THAT_READ_STEP_LEVEL_POLICY.has(tool)) return null;

  const hasAgent =
    rec.agent !== undefined &&
    typeof rec.agent === "object" &&
    !Array.isArray(rec.agent);

  if (hasAgent) {
    return {
      key: "data_policy",
      message:
        "`data_policy` is declared on the step, where nothing reads it — it must be nested INSIDE `agent:`. " +
        "Left here it is silently ignored and the step dispatches at the default `internal` classification, " +
        "which is the opposite of what declaring it was meant to achieve.",
    };
  }

  return {
    key: "data_policy",
    message:
      "`data_policy` is declared on a step that makes no agent dispatch, so nothing reads it. " +
      "It belongs inside `agent:` on an agent step, or on a `fan_out` step (where it applies to every iteration). " +
      "A classification on a step that never talks to a model describes nothing.",
  };
}
