# src/recipes

The recipe automation engine: parses recipe YAML, validates it against the schema, runs it
(two separate execution engines, see below), enforces cost/token budgets, dispatches triggers
(cron, file-watch, git-hook), and exposes ~40 connector tool implementations recipes can call.
This is the largest subsystem in the repo (~107 files). CLI surface is documented in
`CLAUDE.md` under "Recipe verbs" — this README is about the internals, not the CLI.

## The 5 files that matter and why

- **`yamlRunner.ts`** (3764 lines) — the flat/linear recipe runner. Executes recipes as a
  simple ordered step list. Oldest of the two engines; still the default for simple recipes.
- **`chainedRunner.ts`** (1840 lines) — the DAG/dependency-graph runner. Executes recipes with
  `depends_on`, `parallel`, fan-out/fan-in. Newer engine, gets new features first (see invariant
  below).
- **`validation.ts`** (1390 lines) — recipe YAML lint + schema enforcement (`validateRecipeDefinition`).
  Read this before `parser.ts` (353 lines, the actual YAML→AST parse) — validation is where most
  recipe-authoring footguns get caught (or don't).
- **`RecipeOrchestrator.ts`** — trigger dispatch (`file_watch`, `git_hook`, `on_file_save`,
  `on_test_run`) and in-flight run tracking. Small file (166 lines) but every automated recipe
  execution passes through it.
- **`runBudget.ts`** — cost/token budget enforcement (`RunBudget`, `usdMax`/`tokenMax` gearbox,
  downshift). Both runners are supposed to call into this identically; historically one has
  lagged (see below).

## Invariants you must not break

- **Flat-vs-DAG runner parity.** `yamlRunner.ts` and `chainedRunner.ts` are two independent
  implementations of "run a recipe" and have repeatedly drifted: cancellation support,
  retry/downshift clamping, and price-table caching have each landed in one runner and not the
  other (see `docs/audit-2026-06-09.md`, `docs/audit-2026-06-19.md`). **Any fix or feature added
  to one runner must be checked against the other** — grep the sibling file for the same pattern
  before considering a change done. `src/recipes/__tests__/dispatchRecipe.parity.test.ts` exists
  to catch some of this; it is not exhaustive.
- **Budget enforcement must match actual spend.** `RunBudget` loads the price table once at
  construction; runners must thread that same table through per-step cost calculations rather
  than reloading it (a prior chainedRunner bug reloaded it per-step, see
  `docs/audit-2026-06-09.md`). If `sum(step.costUsd) != runBudget.totals().usd`, something is
  using a stale or mismatched price table.
- **Cancellation via `registerRun`/`unregisterRun`** (`runRegistry.ts`). A runner must register
  its run sequence at start and unregister at end (or on error) — this is how `POST
  /runs/:seq/cancel` finds a live run to abort. A runner that skips this makes cancellation
  silently 404 for every run it executes.
- **Judge steps** (`judgeVerdict.ts`, `judgeSummary.ts`) feed the `judgments` CLI command and the
  judge→refine loop; both runners must emit judge verdicts in the same shape for
  `getHaltSummary`/`getJudgeSummary` to aggregate correctly across recipe types.
- General theme across every audit doc under `docs/audit-*.md`: "fix landed on one code path,
  sibling path missed." Treat any change here as two changes until proven otherwise.

## How to test it

```bash
npm test -- src/recipes          # vitest, subsystem-scoped
npm test                         # full suite
npm run typecheck                # tsc — vitest doesn't catch import/type errors
```

Tests live in `src/recipes/__tests__/` (runner behavior, validation, budget, orchestrator
dispatch, parity checks) and `src/recipes/tools/__tests__/` and `src/recipes/simulation/__tests__/`
for their respective subdirectories. New tools need unit tests per the repo-wide rule in
`CLAUDE.md` ("Testing Requirements") — same file for coverage gates and `outputSchema` audit.
