/**
 * automationSuggestions — pattern-mine the activity log + run history to
 * surface "you've been doing X by hand; want to make a recipe?" hints.
 *
 * From docs/strategic/2026-05-02/memory-ecosystem-report.md §6. Three of
 * the four query-catalog patterns ship here; the fourth ("repeated
 * manual workflow" via PrefixSpan-lite sequence mining) is deferred to
 * a follow-up — the agent flagged it as the only entry in the catalog
 * that requires a new ~50-line primitive (`mineSequences`), and shipping
 * it without dashboard rendering would be premature.
 *
 *   1. **Co-occurring pairs** — tools that often run within W minutes of
 *      each other but don't already appear together in any successful
 *      recipe → "create a recipe?" suggestion.
 *   2. **Installed but unused** — tools registered with the bridge but
 *      never called → "review your installed tool list" suggestion.
 *   3. **Recipe trust graduation** — recipes with ≥ 10 runs all status
 *      "done" → "consider auto-approving" suggestion (does NOT auto-
 *      change policy; this is purely a hint).
 *
 * Pure function over (ActivityLog, RecipeRunLog, ToolRegistry). No I/O
 * of its own; tested in isolation by feeding mock instances. The CLI
 * `patchwork suggest` is a thin printer over this output.
 */

import type { ActivityLog } from "./activityLog.js";
import { computeCoOccurrence } from "./fp/activityAnalytics.js";
import { listTools } from "./recipes/toolRegistry.js";
import type { RecipeRun, RecipeRunLog } from "./runLog.js";

export interface AutomationSuggestion {
  kind:
    | "co_occurring_pair"
    | "installed_but_unused"
    | "recipe_trust_graduation";
  /** Human-facing one-liner — suitable for CLI print or dashboard row. */
  label: string;
  /** Optional structured payload so the dashboard can render specific UIs. */
  details?: {
    /** For co_occurring_pair: ["toolA", "toolB"]. */
    pair?: [string, string];
    /** For co_occurring_pair: how often they co-occurred in the window. */
    count?: number;
    /** For installed_but_unused: list of tool ids that are unused. */
    unusedTools?: string[];
    /** For recipe_trust_graduation: which recipe and its run count. */
    recipeName?: string;
    runCount?: number;
  };
}

export interface AutomationSuggestionDeps {
  activityLog: ActivityLog;
  recipeRunLog?: RecipeRunLog;
  /**
   * Test seam — defaults to the global tool registry. Tests can pass an
   * empty-aware version to assert the "no tools registered" branch.
   */
  listToolNamesFn?: () => string[];
  /**
   * Window for co-occurrence detection (ms). Strategic-plan §6 sample
   * uses 5 minutes; we pick 5 minutes for "tight workflow" patterns and
   * support overrides for tests.
   */
  coOccurrenceWindowMs?: number;
  /**
   * Minimum count before a co-occurring pair is suggested. The agent's
   * sample uses 5; tests can lower this to assert wiring.
   */
  coOccurrenceMinCount?: number;
  /**
   * Lookback for activity-mining. Default 7 days — fresh enough to
   * reflect current habits, long enough that 5+ co-occurrences is real
   * signal not noise.
   */
  activitySinceMs?: number;
  /**
   * Min runs before a recipe qualifies for trust-graduation suggestion.
   * Default 10. Lower for tests.
   */
  trustGraduationMinRuns?: number;
}

const DEFAULT_CO_OCCURRENCE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_CO_OCCURRENCE_MIN_COUNT = 5;
const DEFAULT_ACTIVITY_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TRUST_GRADUATION_MIN_RUNS = 10;

/**
 * Compute the full suggestion set. Returns at most 30 suggestions
 * (10 of each kind) sorted by salience within each bucket.
 */
export function computeAutomationSuggestions(
  deps: AutomationSuggestionDeps,
): AutomationSuggestion[] {
  const window = deps.coOccurrenceWindowMs ?? DEFAULT_CO_OCCURRENCE_WINDOW_MS;
  const minCount = deps.coOccurrenceMinCount ?? DEFAULT_CO_OCCURRENCE_MIN_COUNT;
  const sinceLookback = deps.activitySinceMs ?? DEFAULT_ACTIVITY_SINCE_MS;
  const minRuns =
    deps.trustGraduationMinRuns ?? DEFAULT_TRUST_GRADUATION_MIN_RUNS;

  const sinceMs = Date.now() - sinceLookback;
  const recent = deps.activityLog.queryAll({ sinceMs });

  const suggestions: AutomationSuggestion[] = [];

  // (1) Co-occurring tool pairs that aren't already in a recipe.
  // The agent's filter `!pairAlreadyInRecipe(p, runs)` requires us to
  // know which (tool, tool) pairs ever appeared together inside a single
  // recipe run. We synthesize that set from RecipeRun.stepResults.
  const pairsInRecipes = deps.recipeRunLog
    ? buildRecipePairSet(deps.recipeRunLog)
    : new Set<string>();
  const coOccurringPairs = computeCoOccurrence(recent, window, 50)
    .filter((p) => p.count >= minCount)
    .filter((p) => !pairsInRecipes.has(p.pair));
  for (const { pair, count } of coOccurringPairs.slice(0, 10)) {
    const [a, b] = pair.split("|") as [string, string];
    suggestions.push({
      kind: "co_occurring_pair",
      label: `You called ${a} and ${b} together ${count} times in the last 7 days. Create a recipe?`,
      details: { pair: [a, b], count },
    });
  }

  // (2) Installed but never used (in the lookback window).
  const listToolNames = deps.listToolNamesFn ?? defaultListToolNames;
  const installed = listToolNames();
  if (installed.length > 0) {
    const usedSet = new Set<string>();
    for (const e of recent) {
      if (e.tool) usedSet.add(e.tool);
    }
    const unused = installed.filter((t) => !usedSet.has(t));
    if (unused.length > 0) {
      // Single rolled-up suggestion with the count + a few examples;
      // listing every unused tool would flood the output for fresh
      // installs where ~150 of 170 tools have never been called.
      const examples = unused.slice(0, 5);
      const more = unused.length > 5 ? `, … (+${unused.length - 5} more)` : "";
      suggestions.push({
        kind: "installed_but_unused",
        label: `${unused.length} installed tools haven't been used in the last 7 days. Examples: ${examples.join(", ")}${more}.`,
        details: { unusedTools: unused.slice(0, 50) },
      });
    }
  }

  // (3) Recipe trust graduation — recipes with ≥ minRuns successful runs.
  if (deps.recipeRunLog) {
    const byRecipe = groupRunsByRecipe(deps.recipeRunLog);
    const graduates = [...byRecipe.entries()]
      .filter(([, runs]) => runs.length >= minRuns)
      .filter(([, runs]) => runs.every((r) => r.status === "done"))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);
    for (const [recipeName, runs] of graduates) {
      suggestions.push({
        kind: "recipe_trust_graduation",
        label: `Recipe \`${recipeName}\` has succeeded ${runs.length}/${runs.length} times — consider trust graduation.`,
        details: { recipeName, runCount: runs.length },
      });
    }
  }

  return suggestions;
}

function defaultListToolNames(): string[] {
  return listTools().map((t) => t.id);
}

/**
 * Build the set of (toolA, toolB) pairs that ever appeared together
 * inside a single recipe run. Pairs are alphabetized to match
 * `computeCoOccurrence`'s key shape ("a|b" with a < b).
 *
 * We pull from the most recent 500 runs (the default in-memory cap) —
 * older runs are evicted from RAM and we don't pay for the disk scan
 * here; if a tool pair only ever appeared in a 6-month-old run, the
 * suggestion will fire as if the pair is new, which is a fine UX
 * (the user has time to re-promote it).
 */
function buildRecipePairSet(runLog: RecipeRunLog): Set<string> {
  const pairs = new Set<string>();
  const runs = runLog.query({ limit: 500 });
  for (const run of runs) {
    if (!run.stepResults || run.stepResults.length < 2) continue;
    const tools = run.stepResults
      .map((s) => s.tool)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    for (let i = 0; i < tools.length; i++) {
      for (let j = i + 1; j < tools.length; j++) {
        const a = tools[i];
        const b = tools[j];
        if (!a || !b || a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        pairs.add(key);
      }
    }
  }
  return pairs;
}

function groupRunsByRecipe(runLog: RecipeRunLog): Map<string, RecipeRun[]> {
  const grouped = new Map<string, RecipeRun[]>();
  // We pull more than the default 100 since we're computing aggregate
  // stats — 500 is the in-memory cap and matches the typical buffer.
  const runs = runLog.query({ limit: 500 });
  for (const run of runs) {
    const list = grouped.get(run.recipeName) ?? [];
    list.push(run);
    grouped.set(run.recipeName, list);
  }
  return grouped;
}
