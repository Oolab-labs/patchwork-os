# Recipe CLI Dogfood — 2026-05-01

Source: alpha.35 built fresh (`npm run build`). CLI driven via `node dist/index.js` (workspace-resident binary; live bridge alpha.34 left untouched). Live bridge port 3101 used for HTTP comparison only.

Build:  PASS — `tsc` clean, postinstall ran. No source patches.

Discovery: `node dist/index.js recipe --help` prints **nothing** (silent exit 0). Surface enumerated from `src/index.ts:174-1700` dispatch chain. Twelve subcommands present: `list`, `install`, `uninstall`, `enable`, `disable`, `run`, `new`, `lint`, `preflight`, `fmt`, `schema`, `record`, `test`, `watch`. (The roster the user gave was approximate — there is no top-level `recipe lint`-vs-`recipe preflight` distinction; both exist.)

Existing `~/.patchwork/recipes/` left clean at end. Only mutation: re-saved `greet.json` via JSON-path install (idempotent overwrite of identical content).

---

## Per-command results

| # | Command | Args | RC | Output (truncated) | Expected vs Actual | Severity |
|---|---|---|---|---|---|---|
| 1 | `recipe` | — | 0 | (silent) | Should print usage | **major** UX |
| 2 | `recipe --help` | — | 0 | (silent) | Should print usage | **major** UX |
| 3 | `recipe list` | — | 0 | one row (`test-recipe-local`) | HTTP `/recipes` returns **17** rows; CLI returns **1** | **major** parity gap |
| 4 | `recipe install ./examples/recipes` | local dir | 0 | installed as `recipes/` | Works; install dir naming is a footgun (collides with anything literally named "recipes") | minor |
| 5 | `recipe install /tmp/dogfood-recipe-pkg` (single YAML in dir) | local | 0 | OK; status: **disabled** by default | New installs land **disabled** — surprising, undocumented in success copy | minor |
| 6 | `recipe install /tmp/dogfood-recipe-pkg` (re-install) | local | 0 | "✓ Installed" — no "(overwriting)" | Silent overwrite; should say `replaced` like JSON path does | minor |
| 7 | `recipe install /tmp/dogfood-bad-pkg` (malformed YAML inside) | local | 0 | Installs successfully | **No lint/preflight at install time** — broken recipes get planted on disk | **major** correctness |
| 8 | `recipe install /tmp/greet-copy.json` (JSON file) | local | 0 | "replaced …" + permissions snippet | Works; legacy installer path | OK |
| 9 | `recipe install ./examples/recipes/google-meet-debrief-single.yaml` (single YAML) | local | 1 | `Error: Local path is not a directory` | **JSON files install standalone, YAML files cannot** — asymmetry has no justification | minor parity gap |
| 10 | `recipe install morning-brief@1.0.0` | bare name@ver | 1 | "Unrecognized install source" | No registry resolver; PR #39 was about `gh:owner/repo@<ref>` ref pinning, not name-based registry. Documented behavior. | OK |
| 11 | `recipe install gh:patchworkos/recipes@nonexistent-ref` | github + ref | 1 | `HTTP 404 fetching …?ref=nonexistent-ref` | `@<ref>` IS plumbed (ref shows in API URL). PR #39 confirmed working. | OK |
| 12 | `recipe enable dogfood-recipe-pkg` | — | 0 | "✓ enabled" | Removes `.disabled` marker | OK |
| 13 | `recipe enable dogfood-recipe-pkg` (already on) | — | 0 | "ℹ … already enabled" | Idempotent | OK |
| 14 | `recipe enable nonexistent-zzz` | — | 1 | "No installed recipe named …" | Clear error | OK |
| 15 | `recipe disable dogfood-recipe-pkg` | — | 0 | writes `.disabled` marker | OK | OK |
| 16 | `recipe uninstall dogfood-recipe-pkg` | — | 0 | "✓ Uninstalled …" | Removes dir | OK |
| 17 | `recipe uninstall dogfood-recipe-pkg` (already gone) | — | 1 | "Error: No installed recipe named …" | Idempotent failure | OK |
| 18 | `recipe lint examples/recipes/morning-inbox-triage.yaml` | good (apiVersion missing) | 0 | "✓ Valid recipe (0 warnings)" + apiVersion note printed inline | Counter says **0 warnings** but printed a deprecation note above. Misleading. | minor |
| 19 | `recipe lint ~/.patchwork/recipes/my-test-recipe.yaml` | bad YAML | 1 | "✗ YAML parse error: Nested mappings…" with column pointer | Excellent error UX | OK |
| 20 | `recipe preflight examples/recipes/morning-inbox-triage.yaml` | good | 1 | "4 error(s)" — unresolved tools | OK exit + clear errors. **`apiVersion` warning printed 3× per run** (preflight reloads recipe in 3 phases). | minor noise |
| 21 | `recipe preflight ~/.patchwork/recipes/my-test-recipe.yaml` | bad YAML | 1 | `Error: Nested mappings are not allowed…` | Bare `Error:` prefix; **doesn't reuse the formatted lint UX** (✗ + caret pointer). Lint emits cleaner errors than preflight on the same file. | minor |
| 22 | `recipe preflight … --json` | bad recipe | 1 | full JSON: `{ ok: false, issues: [...], plan: {...} }` | Schema OK; exits 1 cleanly | OK |
| 23 | `recipe preflight examples/recipes/google-meet-debrief-single.yaml` | (3 steps, params) | 0 | "✓ Preflight passed" + 3× apiVersion + 6× "Deprecated recipe step field: params" | **Same warning printed 6 times for a 3-step recipe**. Preflight runs the loader for both lint and plan phases, each emits its own deprecation log. | minor noise |
| 24 | `recipe fmt --check ~/.patchwork/recipes/ambient-journal.yaml` | installed user recipe | 1 | "✗ File would be reformatted" | fmt wants to add `apiVersion: patchwork.sh/v1` and rewrite content as block scalar. Production-installed recipes do not pass their own formatter. | minor |
| 25 | `recipe fmt /tmp/ambient-orig.yaml` | (write) | 0 | "✓ Formatted" | OK | OK |
| 26 | `recipe schema /tmp/dogfood-schema` | — | 0 | wrote `recipe.v1.json` + `dry-run-plan.v1.json` + 22 tool schemas | OK | OK |
| 27 | `recipe new dogfood-tmp --out /tmp` | — | 0 | "✓ Created /tmp/dogfood-tmp.yaml" | File created. **Default description `Recipe: <name>` produces invalid YAML** — see #28. | **major** correctness |
| 28 | `recipe lint /tmp/dogfood-tmp.yaml` | freshly-generated | 1 | "✗ YAML parse error: Nested mappings are not allowed in compact mappings at line 4, column 14" | **`recipe new` generates a recipe that fails its own `recipe lint`.** Source: `src/index.ts:1228` — `description: \`Recipe: ${recipeName}\`` injects unquoted colon-space into a YAML scalar. Quote it (`\"Recipe: ${name}\"`), or use a block scalar, or change the default to a colonless wording. | **major** correctness |
| 29 | `recipe new --help` | help flag | 0 | "✓ Created /Users/wesh/.patchwork/recipes/--help.yaml" | **Footgun.** `--help` is treated as the recipe name. `recipe new` does not validate that name doesn't start with `-`. Created `--help.yaml` in `~/.patchwork/recipes/` (cleaned up). Source: `src/index.ts:1203` — `args[0]` taken verbatim. | **major** UX/safety |
| 30 | `recipe run greet --dry-run --local` | safe single-step | 0 | full plan JSON with `lint.warnings: []` | Dry-run works. **stderr deprecation warnings (3) NOT mirrored into `lint.warnings`** in the JSON output. | minor |
| 31 | `recipe run branch-health --dry-run --local` | chained, has lint errors | 0 | plan JSON with `lint.errors: [6 entries]` | **Exits 0 even when `lint.errors` populated.** Inconsistent with `recipe preflight` which exits 1 on the same recipe. | minor |
| 32 | `recipe run zzz-nonexistent --local` | — | 1 | `Error: recipe "zzz-nonexistent" not found in /Users/wesh/.patchwork/recipes` | Clear | OK |
| 33 | `recipe run local-noop --local` | by name (subdir!) | 1 | "recipe … not found" | **Cannot resolve recipes in subdirs even though `recipe list` shows them via marketplace listing.** `~/.patchwork/recipes/test-recipe-local/local-noop.yaml` is invisible to name-based `recipe run`. | **major** parity gap |
| 34 | `recipe run ~/.patchwork/recipes/test-recipe-local/local-noop.yaml --local` | by file path | 0 | "✓ local-noop — 1 step(s)" | Works; agent step yields placeholder `agent_output` (no driver). | OK |
| 35 | `recipe run ~/…/local-noop.yaml` (bridge auto-detect, no `--local`) | file path | 0 | runs locally anyway | Bridge HTTP path skipped because explicit file paths bypass it. Documented in `src/index.ts:1006`. | OK |
| 36 | `recipe test examples/recipes/google-meet-debrief-single.yaml` | no fixtures | **0** | "2 error(s)" — missing fixture libraries | **`recipe test` exits 0 even with errors.** Inconsistent with lint/preflight which exit 1. CI invocations of `recipe test` will pass when they should fail. | **major** correctness |
| 37 | `quick-task explainCode` | (live bridge alpha.34) | 1 (after fix-up) | first attempt: `DOMException [TimeoutError]` thrown raw at `dist/commands/task.js:127`; second attempt with `--json --port 3101`: `{httpStatus:429, ok:false, error:"No active bridge session — connect a client first"}` exit 1 | Happy path passes message through. **30 s fetch timeout has no try/catch — produces an unhandled-rejection stack trace instead of a clean error message** (`src/commands/task.ts:174-181`). Wrap in try/catch, print `Error: bridge unreachable` on AbortError. | minor |

---

## Cross-cutting issues

### 1. Silent `--help` everywhere
- `recipe`, `recipe --help`, `recipe new --help` (the worst — creates a file named `--help.yaml`). `commander` or even a flat lookup table would close all three.
- Source: `src/index.ts:174-180` (`recipe` enters dispatch chain; no fallback when none of the `argv[3]` branches match).

### 2. CLI list ≠ HTTP list
- `listInstalledRecipes()` (`src/commands/recipeInstall.ts:667-720`) only walks **directory** entries (manifest- or YAML-bearing) and does **not** enumerate top-level YAML/JSON files.
- HTTP `/recipes` endpoint enumerates everything in `~/.patchwork/recipes/` (16 files at root + 1 subdir = 17 entries).
- Result: every recipe NOT installed via the marketplace flow is invisible to `recipe list`. User sees one recipe; HTTP says seventeen.

### 3. Subdir recipes not resolvable by name
- `recipe run <name>` only resolves recipes at `~/.patchwork/recipes/<name>.{yaml,yml,json}` (top level). Recipes installed under namespaced dirs (`test-recipe-local/local-noop.yaml`) require explicit file path. The list/run identity model is split.

### 4. `recipe new` template generates broken YAML
- Default description string `Recipe: <name>` (unquoted) creates a compact-mapping parse error on every fresh recipe. `lint` rejects what `new` produces.

### 5. Exit code inconsistency
| Command | RC on errors | RC on warnings |
|---|---|---|
| `recipe lint` | 1 | 0 |
| `recipe preflight` | 1 | 0 |
| `recipe run --dry-run` | **0** even with `lint.errors` | 0 |
| `recipe test` | **0** even with errors | 0 |
- CI scripts that run `recipe test` or `recipe run --dry-run` will silently pass for broken recipes.

### 6. Spammy duplicate stderr noise
- `apiVersion` migration warning printed 1× per recipe load. `preflight` loads 3×; `fmt` loads 2×; `recipe new` template emits no warning. Fix: dedupe via a per-process Set keyed by `(file, warning-id)`.
- `Deprecated recipe step field: params` printed 2× per `params` block on `preflight` (3-step recipe → 6 prints).

### 7. Install pre-write validation absent
- `recipe install <local-pkg>` does not preflight or lint the package before copying to `~/.patchwork/recipes/`. Bad YAML is happily planted, then must be uninstalled to recover.

### 8. JSON/YAML install asymmetry
- `recipe install foo.json` — works (legacy `installRecipeFromFile` path, line 1148-1162).
- `recipe install foo.yaml` — rejected with "Local path is not a directory".
- No technical reason; YAML single-file install would just route through the same legacy path.

### 9. Surface name vs return shape (CLI vs HTTP)
- HTTP `/recipes/run` returns `{ok, taskId}` (enqueued).
- CLI `recipe run` (file path) prints step-by-step report locally — no taskId, different shape.
- HTTP includes per-recipe `lint` summary in the list endpoint; CLI does not.

---

## TL;DR

**Worked**:
`recipe install` (dir, JSON), `recipe uninstall`, `recipe enable`/`disable`, `recipe lint` (good + bad), `recipe preflight` (good + bad, including `--json`), `recipe schema`, `recipe fmt`, `recipe run --dry-run`, `recipe run` by file path, `gh:owner/repo@<ref>` pinning, `quick-task --json`.

**Broke / regressed**:
- `recipe new --help` → creates `~/.patchwork/recipes/--help.yaml` (no `-` guard on name).
- `recipe new` default description generates lint-failing YAML (`description: Recipe: <name>` unquoted).
- `recipe install` plants malformed YAML on disk (no preflight pre-write).
- `recipe test` exits 0 with missing-fixture errors.
- `recipe run --dry-run` exits 0 on `lint.errors`-flagged recipes.
- `recipe list` shows 1/17 of what HTTP `/recipes` lists (only directory installs visible).
- `recipe run <name>` cannot resolve recipes inside subdirectories (visible in HTTP, invisible to CLI).
- `recipe`/`recipe --help` print nothing. No usage page.
- `recipe install <single>.yaml` rejected; `<single>.json` accepted.
- `quick-task` raw `TimeoutError` on bridge fetch timeout.

**CLI lags HTTP**:
- Enumeration: HTTP lists 17, CLI lists 1.
- Resolution: HTTP can run `local-noop` by name; CLI cannot.
- Lint summary: HTTP `/recipes` returns per-recipe `lint: {ok, errorCount, …}`; CLI list omits it.

**HTTP lags CLI** (none observed). Every CLI-only feature (`new`, `fmt`, `schema`, `lint`, `preflight`, `record`, `test`, `watch`) is a tooling-only concern — no HTTP analogue is missing in practice.

**Severity ranking of bugs to fix** (rough):
1. `recipe new --help` → file named `--help.yaml` (safety/UX).
2. `recipe new` template → invalid YAML (every new user trips this).
3. `recipe install` no pre-write validation (corrupts user state).
4. `recipe test` / `recipe run --dry-run` exit 0 on errors (CI silently passes broken recipes).
5. `recipe list` parity with HTTP (one-row output is a credibility hit).
6. `recipe run <name>` for subdir-installed recipes.
7. Add `recipe --help` and `recipe new --help` proper usage emission.
8. Dedupe migration/deprecation warnings.
