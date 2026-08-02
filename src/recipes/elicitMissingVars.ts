/**
 * Inline prompting for a recipe's missing required vars, over MCP elicitation.
 *
 * The first in-repo caller of `McpTransport.elicit()` (#1217). Deliberately the
 * LOW-STAKES caller: a run that would halt with `missing_required_vars:foo,bar`
 * asks the operator for `foo`/`bar` inline instead. The approval prompt — the
 * other candidate — was passed over because inlining an approve/deny decision
 * moves the human's decision point inside the prompt-injection blast radius.
 * Supplying a missing input carries no such authority.
 *
 * Design constraints, all of which the caller relies on:
 *
 *  - **Additive, never a replacement.** `elicit()` requires an active WS client,
 *    so Streamable-HTTP and stdio sessions can never use this path. Every
 *    failure mode — no client, client declines, client has no elicitation
 *    support, timeout, malformed answer — returns `{}` and lets the caller fall
 *    through to the existing `missing_required_vars` halt unchanged.
 *  - **Fail-closed is preserved.** This function can only ever ADD values that a
 *    human typed. It never invents a value, never accepts a blank, and never
 *    reduces the missing set on its own. A run that would have halted still
 *    halts unless a human actually answered.
 *  - **No partial credit.** A caller must re-run its own required-vars check on
 *    the merged result rather than trusting this to have filled everything.
 */

/**
 * The `elicit()` shape this module needs, injected so the recipe layer neither
 * imports nor reaches for a transport instance (they are per-session and owned
 * by the bridge).
 */
export type ElicitFn = (
  message: string,
  requestedSchema: Record<string, unknown>,
) => Promise<unknown>;

/** A declared-but-unsupplied var, as surfaced to the operator. */
export interface MissingVarDeclaration {
  name: string;
  /** `description` from the recipe's `trigger.inputs[]`/`vars[]` entry, if any. */
  description?: string;
}

/**
 * Build the `requestedSchema` for a set of missing vars: one required string
 * property per var. Kept separate from the request so it can be asserted
 * directly — a schema that marks a var optional would let a client return an
 * answer with the var still absent, which reads as "answered" downstream.
 */
export function buildMissingVarsSchema(
  declarations: MissingVarDeclaration[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const { name, description } of declarations) {
    properties[name] = {
      type: "string",
      ...(description ? { description } : {}),
    };
  }
  return {
    type: "object",
    properties,
    required: declarations.map((d) => d.name),
  };
}

/** Human-readable prompt text. Named the recipe so the operator has context. */
export function buildMissingVarsMessage(
  recipeName: string,
  declarations: MissingVarDeclaration[],
): string {
  const names = declarations.map((d) => d.name).join(", ");
  const plural = declarations.length === 1 ? "value" : "values";
  return `Recipe "${recipeName}" needs ${plural} for: ${names}`;
}

/**
 * Read the answer object out of whatever the client returned.
 *
 * MCP elicitation results are `{ action, content }`. Only `action: "accept"`
 * counts — `"decline"` and `"cancel"` are the user saying no, which must land
 * in the same halt as never having asked. A bare object with no `action` is
 * tolerated for older/looser clients, since the per-value validation below is
 * what actually protects us.
 */
function extractAccepted(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  if (typeof obj.action === "string") {
    if (obj.action !== "accept") return null;
    const content = obj.content;
    return content && typeof content === "object"
      ? (content as Record<string, unknown>)
      : null;
  }
  return obj;
}

/**
 * Ask the connected MCP client for the missing vars.
 *
 * @returns a map of ONLY the vars the human actually supplied a non-blank
 * string for. `{}` on every failure path — this never throws, and never
 * returns a key it was not asked for.
 */
export async function elicitMissingVars(opts: {
  recipeName: string;
  declarations: MissingVarDeclaration[];
  elicit: ElicitFn;
  /** Optional; defaults to `elicit()`'s own 5-minute timeout. */
  timeoutMs?: number;
  onWarn?: (message: string) => void;
}): Promise<Record<string, string>> {
  const { recipeName, declarations, elicit, onWarn } = opts;
  if (declarations.length === 0) return {};

  let result: unknown;
  try {
    result = await elicit(
      buildMissingVarsMessage(recipeName, declarations),
      buildMissingVarsSchema(declarations),
    );
  } catch (err) {
    // No WS client, no elicitation support, decline, disconnect, or timeout.
    // All identical from here: the caller halts exactly as it did before.
    onWarn?.(
      `[recipe] could not prompt for missing vars (${recipeName}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }

  const answers = extractAccepted(result);
  if (!answers) return {};

  const supplied: Record<string, string> = {};
  for (const { name } of declarations) {
    const value = answers[name];
    // Only strings count. A number/boolean/null would stringify into something
    // the operator did not type, and a blank is the same as unanswered — the
    // required-vars check treats whitespace-only as missing, so accepting one
    // here would just fail the recheck one line later.
    if (typeof value !== "string" || value.trim() === "") continue;
    supplied[name] = value;
  }
  return supplied;
}
