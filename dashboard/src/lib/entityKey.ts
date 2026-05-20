/**
 * Canonical entity-key helpers for the dashboard.
 *
 * Three pages previously each implemented their own ad-hoc stripping for
 * recipe identity (RecipeLeaderboard, activity/page, inbox/page). They
 * disagreed on edge cases, which caused the same recipe to render under
 * different keys / links on different pages. Centralize here so every page
 * computes the same key for the same input.
 *
 * The bridge stays authoritative for trigger-source parsing (see
 * `RecipeRunLog.parseTrigger` in `src/runLog.ts` ~line 198). The
 * `parseTriggerSource` export below is a client-side port of that parser
 * for dashboard-local computation; behavior mirrors the bridge exactly.
 */

/** Agent-axis suffixes the bridge appends to recipe names. */
const AGENT_AXIS_SUFFIX_RE = /:(?:agent|cron|webhook)$/;

/**
 * Canonical recipe-identity key.
 *
 * - Trims surrounding whitespace.
 * - Strips a trailing agent-axis suffix (`:agent` / `:cron` / `:webhook`).
 * - Case-sensitive — does NOT lowercase. Recipe names are case-sensitive
 *   on disk and the bridge treats them as such.
 *
 * Returns the bare recipe name. Empty-string in → empty-string out.
 */
export function canonicalRecipeKey(name: string): string {
  if (typeof name !== "string") return "";
  return name.trim().replace(AGENT_AXIS_SUFFIX_RE, "");
}

export type TriggerKind =
  | "manual"
  | "cron"
  | "webhook"
  | "recipe"
  | "agent";

export interface ParsedTriggerSource {
  trigger: TriggerKind;
  recipeName?: string;
  parentSeq?: number;
}

/**
 * Parse a recipe-run triggerSource string.
 *
 * Mirrors `RecipeRunLog.parseTrigger` in the bridge
 * (`src/runLog.ts` ~line 198):
 *
 *     /^(cron|webhook|recipe):(.+?)(?::p(\d+))?$/
 *
 * The bridge's parser only knows three trigger kinds (cron / webhook /
 * recipe) and returns `null` for anything else; the dashboard sees a
 * broader set of inputs (manual UI launches, agent-axis names) so this
 * port widens the return type to a discriminated union instead of `null`.
 * For inputs the bridge would have accepted, the `{trigger, recipeName,
 * parentSeq?}` shape is byte-for-byte identical.
 *
 * Behavior for inputs the bridge would reject:
 *   - missing / falsy           → `{trigger: "manual"}`
 *   - bare name (no prefix)     → `{trigger: "manual", recipeName: <input>}`
 *   - `<name>:agent`            → `{trigger: "agent", recipeName: <name>}`
 */
export function parseTriggerSource(src: string): ParsedTriggerSource {
  if (typeof src !== "string" || src.length === 0) {
    return { trigger: "manual" };
  }
  // Bridge's exact regex — keep in lockstep with src/runLog.ts.
  const m = /^(cron|webhook|recipe):(.+?)(?::p(\d+))?$/.exec(src);
  if (m?.[1] && m[2]) {
    const out: ParsedTriggerSource = {
      trigger: m[1] as TriggerKind,
      recipeName: m[2],
    };
    if (m[3] !== undefined) out.parentSeq = parseInt(m[3], 10);
    return out;
  }
  // Bridge returns null here. Dashboard widens to expose the original
  // input as either an `agent`-axis run or a manual launch.
  const agentMatch = /^(.+):agent$/.exec(src);
  if (agentMatch?.[1]) {
    return { trigger: "agent", recipeName: agentMatch[1] };
  }
  return { trigger: "manual", recipeName: src };
}

/**
 * Inbox filename → display/identity key.
 *
 * Strips a trailing `.md` and nothing else. Does NOT strip the trailing
 * date — date stays part of the inbox item's identity for display.
 * (The old inbox page stripped `-YYYY-MM-DD` as a recipe-name guess;
 * that responsibility is moving to provenance metadata in a sibling PR.)
 */
export function inboxItemKey(name: string): string {
  if (typeof name !== "string") return "";
  return name.replace(/\.md$/, "");
}
