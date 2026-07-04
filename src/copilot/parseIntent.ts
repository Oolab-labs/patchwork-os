/**
 * Deterministic intent parser for the copilot chat pane (Overview deck's
 * "7:copilot", docs/plans/dashboard-terminal-copilot-plan-2026-07-03.md).
 *
 * Tier 1 only: a small, explicit set of safe "lever" intents (pause/enable/
 * run a recipe by name, explain a recent halt). Deliberately NOT an LLM
 * call — every phrasing this recognizes is enumerable and unit-testable,
 * and an unrecognized message always falls back to a canned reply rather
 * than guessing. Recipe/worker AI-creation (the mockup's tiers 2/3) are
 * out of scope here; see the plan doc's risk register for why those need
 * a generation endpoint + lint/preflight wiring + much more safety review
 * before they can ship.
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
  | { kind: "unrecognized"; text: string };

/** "nightly-review" / "nightly review" / "NIGHTLY_REVIEW" all match a
 *  recipe named "nightly-review" — recipe names are typically kebab-case
 *  slugs, so normalize both sides to a common form before comparing. */
function normalizeSlug(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, " ").trim();
}

/** Finds the recipe whose (normalized) name is the longest match found as
 *  a substring of the (normalized) input text — longest wins so a recipe
 *  named "outcome-ingester" doesn't lose to a shorter unrelated match. */
function findMentionedRecipe(
  text: string,
  recipes: CopilotRecipeRef[],
): CopilotRecipeRef | undefined {
  const normalizedText = normalizeSlug(text);
  let best: CopilotRecipeRef | undefined;
  let bestLen = 0;
  for (const r of recipes) {
    const normalizedName = normalizeSlug(r.name);
    if (normalizedName.length === 0) continue;
    if (
      normalizedText.includes(normalizedName) &&
      normalizedName.length > bestLen
    ) {
      best = r;
      bestLen = normalizedName.length;
    }
  }
  return best;
}

const HALT_PATTERN =
  /\b(why|explain)\b.*\bhalt(ed|ing)?\b|\bhalt(ed|ing)?\b.*\bwhy\b/i;
const PAUSE_PATTERN = /\b(pause|disable|stop|turn off|kill)\b/i;
const ENABLE_PATTERN = /\b(enable|resume|unpause|re-?enable|turn on)\b/i;
const RUN_PATTERN = /\b(run|start|trigger|kick off|fire)\b/i;

export function parseCopilotIntent(
  text: string,
  recipes: CopilotRecipeRef[],
): CopilotIntent {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "unrecognized", text };

  const mentioned = findMentionedRecipe(trimmed, recipes);

  // Halt explanation is checked first — "why did X halt" would otherwise
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
  'I can pause, enable, or run a recipe by name, or explain a recent halt — try "pause nightly-review" or "why did outcome-ingester halt".';

const CREATION_HINT =
  "Creating recipes or workers from a goal isn't wired up yet — for now, use Marketplace → Install or `recipe new` for those.";

const CREATION_KEYWORDS =
  /\b(create|build|make|generate|scaffold)\b.*\b(recipe|worker)\b/i;

export interface CopilotReplyResult {
  reply: string;
  action?: {
    kind: "pause_recipe" | "enable_recipe" | "run_recipe";
    recipeName: string;
  };
}

/** Given a parsed intent (and, for explain_halt, the most recent halt
 *  reason if one was found), produce the chat reply + optional proposed
 *  action card. Never executes anything — matches the mockup's "chat
 *  proposes, buttons dispose" rule verbatim. */
export function buildCopilotReply(
  intent: CopilotIntent,
  opts: { haltReason?: string | null } = {},
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
    case "unrecognized":
      if (CREATION_KEYWORDS.test(intent.text)) {
        return { reply: CREATION_HINT };
      }
      return { reply: CAN_DO_HINT };
  }
}
