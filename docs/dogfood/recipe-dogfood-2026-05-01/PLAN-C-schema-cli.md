# PLAN-C — Schema / CLI / Triggers / Routes / Tests

**Scope:** Round 1 + 2 dogfood bugs in the schema, lint, CLI surface, trigger
wiring, HTTP routes, and test coverage of recipe tooling. Twenty bugs across
~10 source files. Companion to PLAN-A (security) and PLAN-B (runner parity).

**Targeted bugs (in scope):** #3, #4, #5, #6, #7, #8, #10, #13, #14, #15, #17,
#18, #19, #20, #21, #22, #23, #24, #26, #27, plus PATCH-ESM-bug, plus F-09
schema-side cap.

**Out of scope (handled elsewhere):**
- PLAN-A: chained `hasWriteSteps` (#1), SSRF on `/recipes/install`, `file.*`
  workspace containment, body schema validation on `POST /recipes/:name/run`.
- PLAN-B: `detectSilentFail` not wired into chained runner (#2),
  `captureForRunlog` not wired into yamlRunner (#9), `morning-brief` agent
  skip (#11), `registrySnapshot` per-step duplication (#25),
  `recordRecipeRun()` not called on JSON-prompt path.

**Bundle target:** 6 PRs. Tests live with the fix that introduces them — no
test-only PR.

---

## Sub-bundle map

| PR | Theme | Bugs closed | Approx LoC |
|---|---|---:|---:|
| **C1** | Lint↔runtime parity (root whitelist + builtins + flat-key rule) | #8, #23, partial #24, partial F3/F10 from D | ~150 |
| **C2** | CLI surface: enumeration + scaffold + help + dedup logs | #4, #7, #17, #20, #26, #27, #5-install-half | ~400 |
| **C3** | Trigger wiring + scheduler hardening | #3, #6, #10, #13, #28 | ~300 |
| **C4** | HTTP routes: PATCH ESM + missing nested routes + `daily-status` resolution | PATCH-ESM, #14, #15 (subset) | ~250 |
| **C5** | CamelCase alias sweep + recipe-tool tests (#93, #103) | #18, #19 | ~600 (mostly tests) |
| **C6** | Schema cap + small-batch (`replayRun` CLI, `quick-task` error) | #21, #22, F-09 schema cap | ~120 |

Total: ~1,820 LoC across six PRs. Average PR ~300 LoC. Largest is C5
(test-heavy, mechanical).

---

## C1 — Lint root whitelist + template parity

**Bugs closed:** #8 (100% lint false-positive), #23 (delete `parser.ts` dead code),
half of #24 (`output:` warning quieted by dedup, full removal still requires
recipe edits).

**Files touched:**
- `src/recipes/validation.ts:356-364` — `builtinKeys` set.
- `src/recipes/validation.ts:392-405` — `validateTemplateReferences` root-key
  loop.
- `src/recipes/validation.ts:501-524` — `extractTemplateDottedPaths` (no
  change in shape; whitelist applied at caller).
- `src/recipes/parser.ts` — **delete file** (alongside its callsite in
  `compiler.ts` import).
- `src/recipes/__tests__/parser.test.ts` — delete or rewrite to target the
  active parser path (`legacyRecipeCompat.normalizeRecipeForRuntime`).
- `src/recipes/legacyRecipeCompat.ts:160-165` — wire dedup Set (see C2 for
  the cross-cutting dedup utility).

**Approach:**

1. Add reserved-root whitelist to lint:
   - Define `RESERVED_TEMPLATE_ROOTS = new Set(["steps", "env", "vars",
     "recipe", "$result"])` near `builtinKeys`.
   - In `validateTemplateReferences` (`validation.ts:393-401`), before the
     `if (!scopedKeys.has(root))` check, short-circuit when
     `RESERVED_TEMPLATE_ROOTS.has(root)`. Rest of the dotted-path validation
     (output-schema warning at lines 406-415) still runs for `steps.X.field`.

2. **Decision flagged:** I recommend the **explicit whitelist** above, *not*
   "any root passes". Rationale:
   - Prevents typos (`{{step.X.data}}` missing the `s` would still fail lint).
   - Matches the runtime contract: `templateEngine.ts:117-133` accepts only
     `steps.` and `env.`; `yamlRunner` accepts flat keys. Five-root whitelist
     covers both runners + chained `vars` block + recipe meta.
   - Caller controls which roots are valid per recipe-kind (chained vs YAML).
     A simple `Set` per call site is safer than a global "if it has a dot,
     trust it" rule.

3. **Built-ins (#3 from D-templates):** the lint advertises `YYYY-MM-DD`,
   `YYYY-MM`, `ISO_NOW` but no runner seeds them. Two options. Recommend
   **option A — seed both runners** rather than drop from lint. Five lines in
   each runner:
   - `src/recipes/yamlRunner.ts:407-412` — add `YYYY-MM-DD`, `YYYY-MM`,
     `ISO_NOW` to the seed `ctx`.
   - `src/recipes/templateEngine.ts:117-133` — extend `parseExpression` to
     recognize the bare-identifier built-in keys (whitelist of 5 names; do
     not open up arbitrary bare idents).

4. **Delete `parser.ts`:** confirmed dead per Round 1 #23 — neither runner
   calls `parseRecipe` (only `__tests__/parser.test.ts` and a non-runtime
   call in `compiler.ts` reference it; `compiler.ts` itself is only invoked
   by `installer.ts` and never by either runner). Document the removal in
   the PR body so future readers don't recreate it. Tests for `renderTemplate`
   (the second exported function in `parser.ts:159`) move to
   `__tests__/legacyRecipeCompat.test.ts` since `renderTemplate` is only
   used by tests.

   **Decision flagged: delete vs keep + comment.** Recommend **delete**.
   The existing dual-grammar confuses every reader who has touched this code
   in the last six months (Round 1 dogfood + this audit both rediscovered
   it). A "this is not the parser you're looking for" comment is a worse
   solution than no parser at all.

**Blast radius:** medium.
- `getCallHierarchy { direction: "incoming" }` on
  `validateTemplateReferences` — only `validateRecipeDefinition`
  (validation.ts:111). One caller chain.
- `extractTemplateDottedPaths` — only `validateTemplateReferences`. No
  other callers.
- `parser.ts` deletion needs `findReferences` on `parseRecipe` and
  `renderTemplate` — both confined to `__tests__/`, `compiler.ts:1`.
- Risk: the lint may now miss real bugs that previously surfaced as a root
  mismatch (e.g. someone writes `{{steeps.X.data}}` — typo — gets a runtime
  failure instead of a lint failure). Mitigated by the explicit whitelist
  (typo `steeps` is not in the set, still rejected).

**Test fixtures (live with this PR):**

1. `src/recipes/__tests__/validation.lintParity.test.ts` (new) — 6 tests:
   - `branch-health.yaml` snapshot → 0 errors after fix (was 6).
   - `triage-brief.yaml` snapshot → 0 errors after fix (was 5).
   - `{{steps.stale.data}}` — accepted.
   - `{{env.HOME}}` — accepted.
   - `{{step.stale.data}}` (typo) — still rejected.
   - `{{steps.stale}}` (no field) — accepted (root-only).
2. Add a snapshot test for built-ins: recipe with `{{YYYY-MM-DD}}` runs
   end-to-end through both runners and produces a non-empty render.
3. Update `templateEngine.test.ts` (`src/recipes/__tests__/templateEngine.test.ts`)
   with two cases for the new bare built-in idents.

---

## C2 — CLI surface: enumeration, scaffold, help, log dedup

**Bugs closed:** #4 (`recipe list` 1-of-N), #7 (default template fails own
lint), #17 (`recipe run <name>` can't reach subdir recipes), #20 (`recipe new
--help` makes `--help.yaml`), #26 (`recipe`/`recipe --help` silent),
#27 (apiVersion / params warnings duplicated), `#5` install-half (preflight
before plant).

**Files touched:**
- `src/commands/recipeInstall.ts:667-720` — `listInstalledRecipes` walker.
- `src/commands/recipeInstall.ts` (top of file) — install-time preflight.
- `src/index.ts:174-180` (recipe dispatch root, no fallback) — emit usage.
- `src/index.ts:1200-1258` — `recipe new` subcommand: name guard + quoted
  description.
- `src/recipes/legacyRecipeCompat.ts:140-180` — emit-once dedup wrapper.
- `src/recipes/migrations/*` (any caller of `apiVersion` warning) — same
  dedup wrapper.
- `src/commands/recipe.ts` (or wherever `runByName` lives — verify) — subdir
  glob in `recipe run <name>` resolver.

**Approach:**

1. **`recipe list` parity (#4):** widen `scanDir` to also enumerate
   `*.yaml`/`*.yml`/`*.json` files at top level, not only directories. Pin:
   `recipeInstall.ts:678-718`. The `if (!statSync(...).isDirectory())
   continue;` filter is the bug. Replace with a branch that:
   - For directories — current logic (manifest first, then YAML files).
   - For top-level files — synthesize an `InstalledRecipeEntry` with `name`
     = basename without extension, `enabled` from `~/.patchwork/config.json`
     disabled list (mirror `setRecipeEnabled` legacy path), `yamlFiles` =
     `[fileBasename]`, `hasManifest: false`.
   - HTTP `/recipes` already does this enumeration (`recipesHttp.ts:213+`)
     — port that walker, don't re-implement.

2. **`recipe new` template (#7) + `--help` guard (#20):**
   - `src/index.ts:1228` change `Recipe: ${recipeName}` to
     `Recipe ${recipeName}` (no colon) **AND** quote the value via the
     template helper (`runNew` already takes a `description` arg — quote at
     point of write in `commands/recipe.ts`'s template rendering).
   - `src/index.ts:1203` add a guard:
     ```
     if (!recipeName || recipeName.startsWith("-")) {
       process.stderr.write("Error: recipe name cannot start with '-' …\n");
       process.exit(1);
     }
     ```
   - Apply the same guard in `recipe enable/disable/uninstall <name>` calls
     (`src/index.ts` other branches that take `args[0]` as a name).

3. **Recipe `--help` (#26):** add a top-level handler at the
   `process.argv[2] === "recipe" && (process.argv[3] === undefined ||
   process.argv[3] === "--help" || process.argv[3] === "-h")` branch. Print
   subcommand list with one-liners. Same shape for `recipe new --help`,
   `recipe run --help`, etc. Kept terse — under 40 lines total. Uses an
   array of `{cmd, summary}` so it's testable.

4. **`recipe run <name>` subdir resolution (#17):** today the resolver
   only checks `~/.patchwork/recipes/<name>.{yaml,yml,json}`. After C2's
   widened enumeration, also check
   `~/.patchwork/recipes/*/<name>.{yaml,yml,json}` (one level deep) and
   `~/.patchwork/recipes/<name>/main.{yaml,yml,json}` for manifest dirs.
   Use `listInstalledRecipes()` as the source of truth — same lookup table
   the dashboard uses.

5. **Dedup deprecation warnings (#27):** add a per-process `Set<string>`
   keyed by `(file, warning-id)` in `legacyRecipeCompat.ts`. `warn(file,
   id, message)` is the new signature; `id` is one of `apiVersion-deprecated`,
   `params-deprecated`, `chain-deprecated`, `output-deprecated`,
   `line-deprecated`. First call writes; subsequent calls for the same
   `(file, id)` are no-ops. Migration warnings in `migrations/*` thread
   through the same Set.
   - The per-process Set is reset on test setup (export a `__resetWarnDedup`
     helper).
   - The dedup is per-`(file, id)` — same warning across different files
     still emits.

6. **Install-time preflight (`#5` install-half):** `recipeInstall.ts`
   currently copies a dir into `~/.patchwork/recipes/` without parsing the
   YAML inside (Round 2 K-verify Repro 3 confirmed). Before the copy, walk
   the source dir, run `validateRecipeDefinition` on each `*.yaml` file, and
   abort with a non-zero exit + clear error if any has parse errors. Keep
   warnings non-fatal (preserves the user's ability to install legacy
   recipes that emit deprecation warnings).
   - **NOT in scope:** SSRF allowlist for the GitHub fetch path or stricter
     URL validation — that lives in PLAN-A.

**Blast radius:** large in surface, small in coupling.
- `listInstalledRecipes` is called by `recipe list`, dashboard
  `/recipes` HTTP, and `setRecipeEnabled`-adjacent code. All three benefit
  from the wider walker.
- `runNew` in `commands/recipe.ts` — only one CLI caller.
- The dedup Set is cleanly isolated to `legacyRecipeCompat.ts` exports.
- `recipe run <name>` resolver — one caller, the CLI dispatch chain.

**Test fixtures:**

1. `src/commands/__tests__/recipeInstall.list.test.ts` (new):
   - 4 fixtures: top-level YAML, top-level JSON, manifest dir, namespaced
     subdir. List should return 4 entries.
2. `src/commands/__tests__/recipe.new.test.ts` extend: add a test that runs
   `runNew({name})` then runs the file through `validateRecipeDefinition`
   — assert 0 errors. (Locks the regression for #7.)
3. `src/__tests__/recipe-cli.integration.test.ts` extend: assert
   `recipe new --help` exits 1 with `Error: recipe name cannot start with '-'`
   and creates **no** file.
4. `src/__tests__/recipe-cli.integration.test.ts` extend: assert `recipe`
   alone prints non-empty stdout containing `list`, `install`, `run`, etc.
   exits 0.
5. `src/recipes/__tests__/legacyRecipeCompat.dedup.test.ts` (new): three
   loads of the same recipe → exactly one apiVersion warning per `(file,
   id)`. Reset helper clears state between tests.
6. `src/commands/__tests__/recipeInstall.preflight.test.ts` (new): install
   a dir containing one good + one broken YAML → exit code 1, neither
   file copied to dest, error message names the broken file.

---

## C3 — Trigger wiring + scheduler hardening

**Bugs closed:** #3 (parser/validator/scheduler trigger-type disagreement),
#6 (YAML-declared `on_file_save`/`on_test_run`/`on_recipe_save`/`git_hook`
never auto-fire), #10 (cron uses local TZ), #13 (`nestedRecipeStep` off-by-
one), #28 (starter-pack `event:` triggers).

**Files touched:**
- `src/recipes/scheduler.ts:178, 193, 232` — broaden trigger pickup, add
  timezone option.
- `src/recipes/validation.ts:57-66` — trigger-type allowlist (canonical).
- `src/recipes/compiler.ts:154-180` — `mapTrigger` exhaustiveness.
- `src/automation.ts:540, 981, 1537, 1601` — `_enqueueRun` + per-recipe
  hook synthesizer.
- `src/recipes/nestedRecipeStep.ts:70` — `>` → `>=` and update message.
- `src/recipes/installer.ts:65-77` — emit AutomationProgram from
  `compileRecipe` and register with the running interpreter.

**Approach:**

### Decision flagged — Trigger wiring strategy (#6)

**Recommended: Option A — wire YAML-declared triggers to the orchestrator.**

Rationale:
- The starter-pack already ships seven recipes (`lint-on-save`,
  `watch-failing-tests`, `ambient-journal`, etc.) that use these trigger
  types. Pulling them out of the schema is a documented breaking change
  to recipe authors who already wrote against the docs.
- The scaffolding to compile a recipe trigger to an `AutomationProgram`
  already exists at `src/recipes/compiler.ts:154-180` (handles `file_watch`,
  `git_hook`). `compileRecipe` is just never called from a runtime path.
- The interpreter (`src/fp/automationInterpreter.ts`) is the right
  abstraction to route per-recipe hooks — it already does cooldown and
  dedup with per-key state.

**Cost of Option A:** medium-large. We need to:
1. Extend `compiler.ts:154-180` switch to handle `on_file_save` (alias for
   `file_watch`), `on_test_run`, `on_recipe_save`. Today the switch throws
   on unknown trigger types — the `chained` case shouldn't compile (it's
   a runner-selector, not a hook), keep that throw.
2. Add a "RecipeAutomationRegistry" that walks
   `~/.patchwork/recipes/*.{yaml,yml,json}` at bridge startup, pulls out
   triggers other than `cron`/`webhook`/`manual`/`chained`, calls
   `compileRecipe`, and registers the resulting `AutomationProgram` with
   `automationInterpreter`. Dedup by recipe-name.
3. Hot reload — when a recipe file is saved (already fired by the
   `onRecipeSave` policy hook), invalidate the registry entry for that
   file and re-compile. Cooldown applies.

**Cost of Option B (drop trigger types from schema):**
- One-line removal in `validation.ts:57-66`.
- Migration note: tell users to move their recipes' triggers to
  `automation-policy.json`. Manual editing of two files instead of one.
- Breaks existing starter-pack recipes (would emit lint errors).

**Tradeoff:** Option A is ~3–4 days; Option B is ~30 minutes. Option A
preserves the recipe-as-self-contained-unit story; Option B fragments the
mental model (recipes for prompts + steps; policy for triggers). Option
A wins on UX and matches the existing docs in CLAUDE.md (the "Automation
Policy" section already lists `onFileSave` / `onTestRun` as hook types
implying recipe-level wiring).

**Recommend Option A.** Scope it to a single PR (this one).

### Reconcile parser ↔ validator (#3)

After C1 deletes `parser.ts`, the validator becomes the canonical trigger
schema. Update `compiler.ts:154-180` to accept the validator's full set:
`{manual, cron, webhook, file_watch, git_hook, on_file_save, on_test_run,
on_recipe_save, chained}`. The `chained` case throws (correct — chained
isn't an automation hook). All others either compile (`file_watch`,
`git_hook`, `on_file_save`, `on_test_run`, `on_recipe_save`) or no-op
(`manual`, `webhook`, `cron` — these are runtime-dispatched elsewhere).

### Scheduler timezone (#10)

`scheduler.ts:232`:
```
const tz = parsed.trigger.timezone ?? cfg.recipes?.timezone ?? "UTC";
const cronJob = cron.schedule(parsed2.expression, () => this.fire(name), { timezone: tz });
```
Add per-recipe `trigger.timezone` field to validation allowlist
(`validation.ts:73-78` cron block). Default `UTC` (not local) — the
breaking change this implies is intentional and called out in the PR.

### nestedRecipeStep off-by-one (#13)

`nestedRecipeStep.ts:70`: `currentDepth > recipeMaxDepth` →
`currentDepth >= recipeMaxDepth`. Update error message to drop `+ 1`.
Add regression test asserting `validateNestedRecipe({recipeMaxDepth: 2,
currentDepth: 2})` returns `valid: false`.

### Starter-pack `event:` trigger (#28)

Two options:
1. **Drop from starter-pack:** mark the seven recipes (`compliment-archive`,
   `meeting-prep`, `quiet-hours-enforcer`, `disagreement-cooldown`, etc.)
   as "vision-tier" — move out of `examples/recipes/` to
   `examples/recipes/_vision-tier/`. Update the `# requires:` markers per
   PR #74's pattern.
2. **Wire them:** would require a generic `event` trigger type in
   `compiler.ts` + a pluggable event source registry. This is roadmap-
   tier work, not bug-fix-tier.

**Recommend option 1** in this PR — the bridge has no event source for
`inbox.new_message` etc. today. Add a `validation.ts` lint warning for
`event` type ("not implemented yet — recipe will not fire").

**Blast radius:** large.
- `installer.ts` adds startup wiring → bridge bootstrap path.
- `automation.ts` already has the hook handlers; we add a new
  registration call site. No interpreter change — just one more Program
  registered per recipe.
- Cron timezone change: one-line in scheduler. Side-effect: any recipe
  that relied on local-TZ behavior shifts. Document as breaking; default
  to UTC.

**Test fixtures:**

1. `src/recipes/__tests__/scheduler.timezone.test.ts` (new): mock
   `cron.schedule`, assert timezone option passed (default UTC, override
   from recipe field).
2. `src/recipes/__tests__/nestedRecipeStep.test.ts` extend: add the
   `>=` regression test.
3. `src/recipes/__tests__/compiler.triggerCoverage.test.ts` (new): assert
   `mapTrigger` accepts every type the validator accepts (excluding
   `chained`). Property test: every type in `validation.ts:57-66`
   compiles or returns a documented no-op.
4. `src/__tests__/recipeAutomationRegistry.test.ts` (new): fire a fake
   `onFileSave` event, assert recipe with matching `on_file_save` trigger
   pattern is enqueued. Negative test: recipe with non-matching glob is
   not.
5. `src/recipes/__tests__/installer.compile.test.ts`: install a recipe
   with `git_hook` trigger; assert AutomationProgram registered with
   interpreter.

---

## C4 — HTTP routes: PATCH ESM + missing nested routes + name resolution

**Bugs closed:** PATCH-ESM, #14 (`daily-status` shadow CLI/HTTP surface),
#15 subset (the routes worth landing).

**Files touched:**
- `src/recipesHttp.ts:200` — replace `require()` with top-level import.
- `src/recipesHttp.ts:155-210` (`setRecipeEnabled`) — surrounding test
  refactor.
- `src/recipeOrchestration.ts:344-358` — canonical recipe resolution.
- `src/recipeRoutes.ts` — add nested routes for the four worth landing.
- `src/__tests__/server-recipes-content.test.ts` — production-path test
  (no `saveConfigFn:` injection).

**Approach:**

### PATCH ESM bug

`recipesHttp.ts:200`:
```
const mod = require("./patchworkConfig.js");  // breaks in ESM
```
Replace with top-level `import { savePatchworkConfig } from "./patchworkConfig.js";`
and call directly. Simpler than dynamic `import()` and matches the rest
of the codebase style.

**Bug Fix Protocol:** write a test FIRST that reproduces the bug. The
existing `dashboard-cli-state-unification.test.ts:85-130` injects
`saveConfigFn:` to bypass the broken path. Add a new test that does NOT
inject — assert `setRecipeEnabled("legacy-name", false)` returns
`{ok: true}` (currently `{ok: false, error: "require is not defined"}`).
Confirm test fails on current source, then fix.

### `daily-status` JSON-vs-YAML resolution (#14)

**Decision flagged — canonical-resolver choice:**

Three layouts disagree:
- `GET /recipes/daily-status` → YAML (`recipesHttp.ts:465-475`)
- `POST /recipes/daily-status/run` → JSON (`recipeOrchestration.ts:344`)
- `GET /recipes` lists both (one entry per file).

**Recommend Option C — by-extension URL disambiguation + canonical name
fallback.**
1. URL path semantics: `/recipes/daily-status` keeps current YAML-first
   behavior (don't break dashboards).
2. Add `/recipes/daily-status.json` and `/recipes/daily-status.yaml` as
   explicit-extension forms — both PR #102's GET/PUT/DELETE and
   PR #102's PATCH route need to thread the extension through to file
   resolution.
3. Run dispatch (`recipeOrchestration.ts:344`) — change ordering. Today:
   JSON first. New: YAML first, fall back to JSON. Same precedence as
   `findYamlRecipePath`. **This is a behavior change for `daily-status`** —
   today firing `daily-status` runs the JSON variant; after this fix it
   runs the YAML. The test fixtures show the YAML variant is the more
   recently maintained one.
4. Add a startup warning (logger.warn) when both variants exist for the
   same name: `"Recipe name 'daily-status' has both .yaml and .json
   variants. YAML wins. Use the explicit /recipes/daily-status.json URL
   to address the JSON variant."`

**Alternative Option D (rejected):** rename the JSON variant to
`daily-status.json-prompt` to disambiguate at the filename level.
Cleaner long-term but breaks the user's installed JSON file naming and
any external bookmarks.

### Missing nested routes (#15)

**Decision flagged — which six routes land?**

Round 2 (H-http-routes.md:78-87) listed six expected-but-404 routes.
Recommend the following landings:

| Route | Land? | Rationale |
|---|---|---|
| `GET /recipes/:name/runs` | **YES** | Pure REST nesting; trivial — wraps `/runs?recipe=:name`. ~10 lines. Closes Round-1 #15. |
| `GET /recipes/:name/permissions` | **YES** | Permissions sidecar files exist on disk; surfacing them is dashboard-parity. ~30 lines. |
| `POST /recipes/:name/permissions` | **YES** | Already needed for grant/revoke UX. Mirrors GET above. ~50 lines. |
| `POST /recipes/:name/preflight` | **NO** | `recipe preflight` is a CLI tool over local files; HTTP equivalent would imply server-side recipe preflight, which is `POST /recipes/lint` + plan. **Document** that recipe preflight is CLI-only. |
| `POST /recipes/:name/lint` | **NO** | Same as preflight — `POST /recipes/lint` accepts content body, that's the canonical API. Rename docs to clarify. |
| `GET /recipes/:name/activation-metrics` | **YES** | Per-recipe metrics view in dashboard requires it. Filter `activationMetrics.recordRecipeRun` data by name. ~40 lines. |
| `GET /recipes/templates` | **NO** | Path is `GET /templates` (already exists). Just a docs fix. |

**Net:** four new routes (`/recipes/:name/runs`, `/recipes/:name/permissions`
× 2, `/recipes/:name/activation-metrics`); two stay 404 with a docs note;
one is a docs fix. Avoids a giant route surface expansion that would need
its own auth/CSRF/rate-limit audit.

**Blast radius:** medium.
- PATCH-ESM fix is one-line; test discovers it.
- `daily-status` dispatch change is risky — it changes which file gets
  executed on a name that's been used in production dogfood. Mitigated
  by: (a) startup warning, (b) explicit-extension URL form for callers
  that need the JSON variant, (c) only one user (the dogfooder) currently
  has both variants installed.
- New routes are net-additive; no existing path changes.

**Test fixtures:**

1. `src/__tests__/server-recipes-content.test.ts` extend: PATCH legacy
   recipe (top-level YAML, no manifest dir) without `saveConfigFn:`
   injection — must succeed (regression for the require bug).
2. `src/__tests__/server-recipes-content.test.ts` extend: GET
   `/recipes/daily-status.yaml` returns YAML; GET
   `/recipes/daily-status.json` returns JSON. Run by canonical name
   prefers YAML.
3. New file `src/__tests__/server-recipes-nested-routes.test.ts`:
   - `GET /recipes/:name/runs` returns same shape as `/runs?recipe=`.
   - `GET /recipes/:name/permissions` 200 with sidecar; 404 without.
   - `POST /recipes/:name/permissions` updates sidecar.
   - `GET /recipes/:name/activation-metrics` returns per-recipe block.
   - `GET /recipes/:name/preflight` returns 404 with explanatory body
     (`{error: "use_cli_preflight"}`).

---

## C5 — CamelCase alias sweep + recipe-tool tests

**Bugs closed:** #18 (PR #93 Jira+Sentry untested), #19 (PR #103 only
2/36 alias pairs shipped).

**Files touched:**
- `src/recipes/toolRegistry.ts:117` — central alias-emission helper.
- `src/recipes/tools/*.ts` — for any `id` containing `_`, ensure the
  registry auto-emits a camelCase alias. Ideally the alias is emitted
  by `registerTool` itself (one change in `toolRegistry.ts`), not by
  per-tool author opt-in.
- `src/recipes/tools/__tests__/jira.test.ts` (new).
- `src/recipes/tools/__tests__/sentry.test.ts` (new).
- `src/recipes/tools/__tests__/aliases.test.ts` (new).

**Approach:**

### Decision flagged — alias strategy (#19)

**Recommended: auto-emit camelCase aliases inside `registerTool`.** Drop
the per-tool-file opt-in pattern (`linear.ts:99-101`, `slack.ts:98-101`)
in favor of a central rule:

```ts
// in registerTool
if (def.id.includes("_") && !def.id.startsWith("_")) {
  const camelId = def.id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (camelId !== def.id) {
    registry.set(camelId, def);  // alias to same impl
  }
}
```

Rationale:
- Avoids per-tool author opt-in, which Round 2 F4 confirmed is forgotten
  in 34 of 36 cases.
- Matches PR #103's stated intent (camelCase parity) with two lines.
- New tools auto-inherit the alias — no future regressions.

**Alternative — rename in-place to one canonical form:** would break
every existing recipe that uses snake_case. Not viable.

**Alternative — drop the aliasing strategy entirely:** would break the
two recipes that already use camelCase (`linear.listIssues`,
`slack.postMessage`). Acceptable but inconsistent with PR #103's
shipped intent.

**Decision: auto-emit aliases.** Document in toolRegistry.ts header
comment.

### PR #93 unit tests (#18)

Add `src/recipes/tools/__tests__/jira.test.ts` covering 6 tools:
- `jira.list_issues` — happy path (mocked HTTP), unauth path
  (`{count:0,items:[],error}` shape), JQL injection guard.
- `jira.get_issue` — happy path, unauth, missing key.
- `jira.list_projects` — happy + unauth.
- `jira.create_issue` — happy + unauth + missing required fields.
- `jira.update_status` — happy + unauth + invalid transition.
- `jira.add_comment` — happy + unauth + empty body rejected.

Total: ~24 tests. Use `vi.fn()` for the connector layer; do not call
real Jira.

Add `src/recipes/tools/__tests__/sentry.test.ts` covering 1 tool:
- `sentry.get_issue` — happy path with mocked Sentry response, unauth
  (`{ok:false,error}` shape), missing `issue` arg.

Total: ~5 tests.

### Camelcase alias regression (#19)

Add `src/recipes/tools/__tests__/aliases.test.ts`:
- Property test: for every snake-case tool registered, assert
  `hasTool(camelCase(id)) === true` and that `executeTool(camelId, params)`
  returns the same shape as `executeTool(snakeId, params)` (mocked).
- Spot tests for the full 36-pair matrix from F-tools.md§4 — explicit
  list, asserting each pair both registers.

**Blast radius:** small.
- One change in `toolRegistry.ts:registerTool`. All existing tests
  pass (alias is additive).
- Two new test files, one extended. Net: ~600 LoC of tests,
  ~10 LoC source change.
- Risk: if a tool name happens to contain a non-`_a-z` byte sequence
  (e.g. `tool_v2`) the regex preserves it correctly. Property test
  catches edge cases.

**Test fixtures:**

All listed above. New tests live in this PR alongside the alias-emission
fix.

---

## C6 — Schema cap + small-batch (replayRun CLI, quick-task error)

**Bugs closed:** #21 (`quick-task` raw DOMException), #22 (`replayRun` no
CLI), F-09 schema-side `maxConcurrency` cap.

**Files touched:**
- `src/commands/task.ts:174-181` — try/catch around fetch.
- `src/index.ts` — wire `replay` subcommand.
- `src/commands/recipeReplay.ts` (new) — CLI shim around `replayMockedRun`.
- `src/recipes/validation.ts` — add `maxConcurrency` upper bound check.
- `src/recipes/manifestSchema.json` — same cap if expressed in JSON Schema.

**Approach:**

1. **`quick-task` error handling (#21):** `task.ts:174-181` is
   `await fetch(...)` with no try/catch. Wrap; map `AbortError` /
   `TimeoutError` to a clean `Error("bridge unreachable: timeout after 30s")`.
   Emit a one-line error not a stack trace. Trivial.

2. **`replayRun` CLI (#22):** add `patchwork recipe replay <seq>` that
   posts to `POST /runs/:seq/replay` if a bridge is reachable, falls
   back to direct `replayMockedRun` import if `--local`. Output the new
   seq + `unmockedSteps` count. ~50 lines including args parsing.

3. **`maxConcurrency` schema cap (F-09):** add a max-100 (or whatever
   PLAN-A defines) check in `validation.ts` for the
   `trigger.maxConcurrency` field. Emit a lint error above the cap.
   Mirror the runtime cap that PLAN-A introduces. Schema-side check
   prevents bad recipes from ever reaching the orchestrator.

**Blast radius:** small. Three independent surfaces, each ~30-50 LoC.

**Test fixtures:**

1. `src/commands/__tests__/task.timeout.test.ts` (new): mock fetch to
   reject with AbortError, assert exit 1 with single-line error.
2. `src/commands/__tests__/recipe.replay.test.ts` (new): CLI shim
   delegates to HTTP when bridge present, to direct import on `--local`.
3. `src/recipes/__tests__/validation.maxConcurrency.test.ts` (new):
   `maxConcurrency: 9999` produces lint error; `100` is fine.

---

## Cross-bundle dependencies

**With PLAN-A (security):**
- `maxConcurrency` runtime cap (PLAN-A) and schema cap (C6) must agree
  on the number. Coordinate constant.
- `/recipes/install` SSRF allowlist (PLAN-A) lands separately from C2's
  install-time preflight; no merge conflict.
- `file.*` workspace containment (PLAN-A) lands separately from any of
  this plan's files.

**With PLAN-B (runners):**
- C3's per-recipe automation registry must call into the runners (chained
  vs YAML) for fire-time. The registration layer doesn't change runner
  internals, so no merge conflict — but if PLAN-B refactors the runner
  selection logic, C3 must rebase on top.
- `detectSilentFail` wiring into chained runner (PLAN-B / Bug #2) is
  prerequisite for chained recipes via `on_file_save`/`on_test_run` to
  produce useful telemetry. Land PLAN-B first, then C3.
- `captureForRunlog` parity (PLAN-B / Bug #9) is independent of C3.

**Recommended merge order:**
1. PLAN-B Bug #2 + Bug #9 (cross-runner safety floor).
2. C1 (lint parity — unblocks dashboard credibility).
3. PLAN-A (security cap, SSRF, workspace containment).
4. C2, C5 (parallel — independent surfaces).
5. C4 (PATCH ESM + nested routes — depends on nothing).
6. C3 (trigger wiring — largest surface, depends on nothing else but is
   the most spec-heavy).
7. C6 (small batch — independent of everything).

---

## Open questions for the maintainer

1. **Trigger wiring (#6) — confirm Option A.** PLAN-C recommends wiring
   YAML-declared triggers to the orchestrator's automation hooks (~3 days
   of work). Confirm before C3 starts.

2. **Lint root whitelist (#8) — explicit five-root set.** PLAN-C
   recommends `{steps, env, vars, recipe, $result}`. Confirm; or expand
   if the recipe schema has reserved roots I missed.

3. **Nested routes (#15) — four new routes, two `/preflight` `/lint`
   stay 404, one `/templates` is a docs fix.** Confirm the four-land set.

4. **CamelCase aliases (#19) — auto-emit in `registerTool`.** Confirm
   the strategy (vs maintaining the per-tool opt-in or doing a full
   rename). Once we ship auto-emit, anyone who later removes the
   `linear.ts:99-101` and `slack.ts:98-101` manual aliasing will not
   cause a regression.

5. **`parser.ts` (#23) — delete.** Confirm; there's a `parser.test.ts`
   that exercises it, but the parser is not on either runtime path.

6. **`daily-status` resolution (#14).** PLAN-C recommends YAML-first
   with explicit-extension URL form. Confirm that this is the intended
   future shape — alternative is to rename JSON variants on disk.

---

## Estimated PR sizing

| PR | Files | LoC source | LoC tests | Risk |
|---|---|---:|---:|---|
| C1 | 5 | 100 | 80 | Medium (deletion) |
| C2 | 6 | 280 | 220 | Medium (CLI surface) |
| C3 | 7 | 200 | 180 | High (trigger wiring) |
| C4 | 5 | 180 | 200 | Medium (route additions) |
| C5 | 4 | 30 | 600 | Low (mostly tests) |
| C6 | 4 | 80 | 60 | Low |

**Total: ~870 source / ~1,340 tests across 6 PRs.** Test:source ratio
1.5:1 — high but appropriate for bug fix work.

---

## Risks not addressed in this plan

- **Runtime parity between yamlRunner and chainedRunner** is treated by
  PLAN-B. Without PLAN-B landing first, C3's trigger wiring will produce
  inconsistent VD-2 capture and silent-fail behavior depending on which
  runner the triggered recipe uses.
- **Schema generator's `kind: prompt` rejection (D-templates F7).** The
  JSON-prompt path bypasses lint and schema. Out of scope here — lives
  with the JSON-prompt rewrite track.
- **`output:` keyword warning per load (#24).** C2 dedups the warning,
  but the recipes still emit `output:`. Migrating `branch-health.yaml`
  and `triage-brief.yaml` to `into:` syntax is one extra commit, not
  source code.
- **Connector tools without try/catch (F-tools F2).** Seven namespaces
  (notion, confluence, zendesk, intercom, hubspot, datadog, stripe)
  bubble unauth throws. Out of scope here — likely belongs in PLAN-B
  or a connector-hardening track.

---

## Bug-status traceability

| Bug | PR | Recommendation |
|---|---|---|
| #3 | C3 | Reconcile via validator-canonical + delete parser. |
| #4 | C2 | Widen `scanDir` to top-level files. |
| #5 (install half) | C2 | Install-time preflight. |
| #6 | C3 | Wire to orchestrator (Option A). |
| #7 | C2 | Quote description / drop colon. |
| #8 | C1 | Reserved-root whitelist. |
| #10 | C3 | `timezone` option to cron.schedule. |
| #13 | C3 | `>=` instead of `>`. |
| #14 | C4 | YAML-first + explicit-extension URLs. |
| #15 (subset) | C4 | Land four nested routes. |
| #17 | C2 | Subdir resolver in `recipe run`. |
| #18 | C5 | Jira + Sentry test files. |
| #19 | C5 | Auto-emit aliases in `registerTool`. |
| #20 | C2 | `-` prefix guard on recipe name. |
| #21 | C6 | try/catch on fetch. |
| #22 | C6 | CLI shim. |
| #23 | C1 | Delete parser.ts. |
| #24 | C2 | Dedup warnings (does not delete `output:` from recipes). |
| #26 | C2 | Help text emission. |
| #27 | C2 | Dedup warnings. |
| #28 | C3 | Move starter-pack `event:` to `_vision-tier/`. |
| PATCH-ESM | C4 | Top-level import. |
| F-09 schema cap | C6 | Add lint error above cap. |
