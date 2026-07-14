/**
 * Deterministic intent parser for the copilot chat pane (Overview deck's
 * "7:copilot", docs/plans/dashboard-terminal-copilot-plan-2026-07-03.md).
 *
 * Tier 1: a small, explicit set of safe "lever" intents (pause/enable/run a
 * recipe by name, explain a recent halt, read-only status Q&A). Deliberately
 * NOT an LLM call — every phrasing this recognizes is enumerable and
 * unit-testable, and an unrecognized message always falls back to a canned
 * reply rather than guessing.
 *
 * Recipe/worker creation (PR 8 of the plan doc) IS handled here, but only as
 * intent *detection* — matching "create/build/make a recipe/worker" and
 * carrying the raw goal text forward. The actual generation (an LLM call via
 * /recipes/generate) and the safety-reviewed install/save step both happen
 * dashboard-side (page.tsx's confirmCopilotAction), never in this
 * deterministic parser. A create_worker card never auto-saves a manifest —
 * `owns`/`autonomyCeiling` need human review, so it hands off to the
 * /workers/new wizard instead; see that page and the plan doc's risk
 * register for why.
 */

export interface CopilotRecipeRef {
  name: string;
  enabled?: boolean;
}

export type CopilotIntent =
  | { kind: "pause_recipe"; recipe: CopilotRecipeRef }
  | { kind: "enable_recipe"; recipe: CopilotRecipeRef }
  | { kind: "run_recipe"; recipe: CopilotRecipeRef }
  | { kind: "explain_halt"; recipe?: CopilotRecipeRef }
  | { kind: "ambiguous_recipe"; candidates: CopilotRecipeRef[] }
  | { kind: "approvals_status" }
  | { kind: "kill_switch_status" }
  | { kind: "create_recipe"; goal: string }
  | { kind: "create_worker"; goal: string }
  | { kind: "unrecognized"; text: string };

/** "nightly-review" / "nightly review" / "NIGHTLY_REVIEW" all match a
 *  recipe named "nightly-review" — recipe names are typically kebab-case
 *  slugs, so normalize both sides to a common form before comparing. */
function normalizeSlug(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, " ").trim();
}

/** Finds every recipe whose (normalized) name is tied for the longest
 *  match found as a substring of the (normalized) input text. A single
 *  result means an unambiguous match (longest wins over shorter
 *  unrelated matches, e.g. "outcome-ingester" over a shorter false
 *  positive); more than one result means the text is genuinely
 *  ambiguous — two distinct recipes both plausibly match — and the
 *  caller must not silently guess which one the user meant. */
function findMentionedRecipes(
  text: string,
  recipes: CopilotRecipeRef[],
): CopilotRecipeRef[] {
  const normalizedText = normalizeSlug(text);
  let bestLen = 0;
  let candidates: CopilotRecipeRef[] = [];
  for (const r of recipes) {
    const normalizedName = normalizeSlug(r.name);
    if (normalizedName.length === 0) continue;
    if (!normalizedText.includes(normalizedName)) continue;
    if (normalizedName.length > bestLen) {
      bestLen = normalizedName.length;
      candidates = [r];
    } else if (
      normalizedName.length === bestLen &&
      !candidates.some((c) => c.name === r.name)
    ) {
      candidates.push(r);
    }
  }
  return candidates;
}

const HALT_PATTERN =
  /\b(why|explain)\b.*\bhalt(ed|ing)?\b|\bhalt(ed|ing)?\b.*\bwhy\b/i;
const PAUSE_PATTERN = /\b(pause|disable|stop|turn off|kill)\b/i;
const ENABLE_PATTERN = /\b(enable|resume|unpause|re-?enable|turn on)\b/i;
const RUN_PATTERN = /\b(run|start|trigger|kick off|fire)\b/i;
const APPROVALS_PATTERN = /\bapprovals?\b/i;
const KILL_SWITCH_PATTERN = /\bkill.?switch\b/i;
// Captures which noun ("recipe" or "worker") the creation verb targets, so
// the two map to distinct intents (a worker card hands off to /workers/new
// instead of ever auto-saving — see module doc). "worker" checked first:
// "create a worker that reviews PRs using the release-notes recipe" mentions
// both nouns, and the worker is the thing actually being created.
const CREATION_PATTERN =
  /\b(?:create|build|make|generate|scaffold)\b.*\b(recipe|worker)\b/i;

export function parseCopilotIntent(
  text: string,
  recipes: CopilotRecipeRef[],
): CopilotIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "unrecognized", text };

  // Read-only status Q&A — independent of recipe matching, checked first
  // since these questions never name a recipe.
  if (KILL_SWITCH_PATTERN.test(trimmed)) return { kind: "kill_switch_status" };
  if (APPROVALS_PATTERN.test(trimmed)) return { kind: "approvals_status" };

  // Creation intent — checked before recipe-name matching so "create a
  // recipe called nightly-review" isn't misread as mentioning an existing
  // recipe of that name (there usually isn't one yet).
  const creationMatch = CREATION_PATTERN.exec(trimmed);
  if (creationMatch) {
    const noun = creationMatch[1]?.toLowerCase();
    return noun === "worker"
      ? { kind: "create_worker", goal: trimmed }
      : { kind: "create_recipe", goal: trimmed };
  }

  const matches = findMentionedRecipes(trimmed, recipes);
  if (matches.length > 1)
    return { kind: "ambiguous_recipe", candidates: matches };
  const mentioned = matches[0];

  // Halt explanation is checked next — "why did X halt" would otherwise
  // also match nothing else, but a phrase like "why is X stopped" could
  // collide with the pause pattern's "stop" if checked in the wrong order.
  if (HALT_PATTERN.test(trimmed)) {
    return mentioned
      ? { kind: "explain_halt", recipe: mentioned }
      : { kind: "explain_halt" };
  }

  if (mentioned) {
    if (PAUSE_PATTERN.test(trimmed))
      return { kind: "pause_recipe", recipe: mentioned };
    if (ENABLE_PATTERN.test(trimmed))
      return { kind: "enable_recipe", recipe: mentioned };
    if (RUN_PATTERN.test(trimmed))
      return { kind: "run_recipe", recipe: mentioned };
  }

  return { kind: "unrecognized", text };
}

const CAN_DO_HINT =
  'I can pause, enable, or run a recipe by name, explain a recent halt, answer "approvals pending"/"kill switch status", or draft a new recipe/worker from a goal — try "pause nightly-review" or "create a recipe that drafts release notes".';

export interface CopilotReplyResult {
  reply: string;
  action?: {
    kind:
      | "pause_recipe"
      | "enable_recipe"
      | "run_recipe"
      | "create_recipe"
      | "create_worker";
    recipeName: string;
    goal?: string;
  };
}

/** Given a parsed intent (plus read-only status context the route
 *  handler already has on hand — halt reason, approvals count,
 *  kill-switch state), produce the chat reply + optional proposed
 *  action card. Never executes anything — matches the mockup's "chat
 *  proposes, buttons dispose" rule verbatim. */
export function buildCopilotReply(
  intent: CopilotIntent,
  opts: {
    haltReason?: string | null;
    approvalsPending?: number;
    killSwitchEngaged?: boolean;
  } = {},
): CopilotReplyResult {
  switch (intent.kind) {
    case "pause_recipe":
      return {
        reply: `That's a lever action — review the card below to disable "${intent.recipe.name}".`,
        action: { kind: "pause_recipe", recipeName: intent.recipe.name },
      };
    case "enable_recipe":
      return {
        reply: `Review the card below to re-enable "${intent.recipe.name}".`,
        action: { kind: "enable_recipe", recipeName: intent.recipe.name },
      };
    case "run_recipe":
      return {
        reply: `Review the card below to run "${intent.recipe.name}" now.`,
        action: { kind: "run_recipe", recipeName: intent.recipe.name },
      };
    case "explain_halt":
      if (!intent.recipe) {
        return {
          reply: opts.haltReason
            ? `Most recent halt: ${opts.haltReason}`
            : "No recent halts I can see — check 0:attention for the current state.",
        };
      }
      return {
        reply: opts.haltReason
          ? `"${intent.recipe.name}" last halted: ${opts.haltReason}`
          : `I don't see a recent halt for "${intent.recipe.name}".`,
      };
    case "ambiguous_recipe": {
      const names = intent.candidates.map((c) => `"${c.name}"`).join(", ");
      return {
        reply: `That matches more than one recipe: ${names}. Try naming one more specifically.`,
      };
    }
    case "approvals_status": {
      const n = opts.approvalsPending ?? 0;
      return {
        reply:
          n === 0
            ? "No approvals pending."
            : `${n} approval${n === 1 ? "" : "s"} pending — see 0:attention or /approvals.`,
      };
    }
    case "kill_switch_status":
      return {
        reply: `Kill switch is ${opts.killSwitchEngaged ? "engaged (writes blocked)" : "released"}.`,
      };
    case "create_recipe":
      return {
        reply:
          "Drafting a recipe from that goal — review the preview below before it's saved.",
        action: { kind: "create_recipe", recipeName: "", goal: intent.goal },
      };
    case "create_worker":
      return {
        reply:
          "Worker manifests need a human review of what it owns and its autonomy ceiling — " +
          "I'll open the worker wizard prefilled from that goal rather than saving one directly.",
        action: { kind: "create_worker", recipeName: "", goal: intent.goal },
      };
    case "unrecognized":
      return { reply: CAN_DO_HINT };
  }
}
