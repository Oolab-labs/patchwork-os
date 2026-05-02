# Master Fix Plan — Recipe Dogfood 2026-05-01

Synthesizes [PLAN-A-security.md](PLAN-A-security.md) (5 PRs) + [PLAN-B-runners.md](PLAN-B-runners.md) (4 PRs) + [PLAN-C-schema-cli.md](PLAN-C-schema-cli.md) (6 PRs) into a sequenced rollout. **15 PRs raw → 12 after deduplication** of overlapping fixes.

## Overlaps to deduplicate before scheduling

| Overlap | Bundles | Decision |
|---|---|---|
| Chained `hasWriteSteps` fix (round-1 #1) | A-PR3 + B-PR2 | **Combine** — same edit to `chainedRunner.generateExecutionPlan` (emit `tool:` field). Ship as one PR under PLAN-B; A-PR3 drops that fix and keeps atomic-write + concurrency clamp. |
| Daily-status JSON/YAML resolver (#14) | B-PR4 + C-PR4 | **Combine** — `resolveRecipe.ts` IS the daily-status fix. Ship under PLAN-B; C-PR4 keeps PATCH-ESM + missing routes only. |
| `maxConcurrency` cap | A-PR3 (runtime) + C-PR6 (schema) | **Coordinate** — share a constant in a new `src/recipes/limits.ts`. Land C-PR6's schema cap one PR before A-PR3's runtime clamp so authors see the lint warning first. |
| Body cap (F-08) | A-PR2 (recipe routes) | Already plan-A only; mention so PLAN-C's HTTP work doesn't collide. |

## Phased rollout

Five phases. Phase boundaries are real — don't ship Phase N+1 without Phase N landing because each phase removes a class of risk that later phases depend on.

### Phase 1 — Stop the bleed (security CRITICALs) — week 1

Parallel; both small-blast-radius:

- **A-PR1** — `resolveRecipePath` helper applied at `file.ts` tools + `yamlRunner` deps + post-render re-validation; `vars` validation at HTTP entry. Closes **F-01, F-02, F-10**.
- **A-PR2** — `loadNestedRecipe` jail + install host allowlist + 256 KB body cap. Closes **F-04, F-05/H-SSRF, F-08**.

Outcome: live-PoC traversal exploits blocked. SSRF closed. Recipe-runner is no longer a sandbox-escape primitive.

### Phase 2 — Architectural foundation — week 2

Sequential within phase. B-PR1 is **load-bearing** for everything in Phase 4–5.

- **B-PR1** — extract `src/recipes/stepObservation.ts` (silent-fail + JSON-err + `captureForRunlog` + tool classification); wire both yaml + chained runners; convert registrySnapshot to delta + run-level final snapshot (`runlogVersion: 2`). Closes **#2, #9, #11-chained, registrySnapshot-bloat, half of #1**.
- **A-PR4** — permissions decision: delete `*.permissions.json` sidecar (Option B per PLAN-A recommendation). Closes **F-03**. Independent; ship same week.

Outcome: one shared post-step pipeline. Chained runner gains silent-fail floor. yamlRunner gains VD-2 capture. registrySnapshot bloat ends. Permissions model honest.

### Phase 3 — Cleanup wins (independent, parallelizable) — week 3

Four PRs, can land same week:

- **C-PR1** — lint whitelist (`steps`/`env`/`vars`/`recipe`/`$result`) + delete dead `parser.ts` + built-in template keys. Closes **#8, #23, partial #24**, eliminates 100% lint false-positive rate.
- **C-PR2** — CLI: list/run subdir resolver, `recipe new` template fix + dash-prefix guard, install preflight, dedup migration warnings, help text. Closes **#4, half-of-#5, #7, #17, #20, #26, #27**.
- **C-PR5** — camelCase auto-emit in `registerTool` + Jira/Sentry test backfill. Closes **#18, #19** (only 2 of 36 aliases shipped → all 36 from one rule).
- **C-PR6** — `quick-task` try/catch, `replayRun` CLI, schema `maxConcurrency` cap (one PR ahead of Phase 4 runtime clamp so authors see warnings first). Closes **#21, #22, half of F-09**.

Outcome: linter trustworthy. CLI usable. Aliases consistent. Tests cover #93 / #103.

### Phase 4 — Coordinated runner fixes — week 4

- **A-PR3 + B-PR2** *(combined)* — `chainedRunner.generateExecutionPlan` emits `tool:` field (closes round-1 cross-cut **#1** and **F-07** together) + atomic temp+rename write (closes **F-06**) + `maxConcurrency` runtime clamp at 16 reading shared constant from `src/recipes/limits.ts` (closes other half of **F-09**).

Outcome: chained recipes truthfully report writes. Concurrent runs no longer race-overwrite. `maxConcurrency` bounded both at lint and runtime.

### Phase 5 — Resolver unification + remaining HTTP — week 5

- **B-PR3** — delete `loadRecipePrompt`; lower `kind:prompt` JSON to synthetic single-agent-step YAML at load time. Eliminates the third runner. lint/schema/`recordRecipeRun`/VD-2/silent-fail apply for free. Depends on B-PR1.
- **B-PR4 + C-PR4** *(combined)* — new `src/recipes/resolveRecipe.ts` as single canonical resolver (YAML-wins-on-collision; closes **#14**) + PATCH `/recipes/:name` ESM `require` bug (closes new HIGH from H) + four missing nested HTTP routes (`/runs`, `/permissions` GET+POST, `/activation-metrics`; closes subset of **#15**).

Outcome: third runner gone; one canonical recipe resolver across HTTP/lint/run/delete; dashboard enable/disable toggle works again.

### Phase 6 — Trigger wiring + repo hygiene — week 6

Now safe because Phase 2 silent-fail floor is in place.

- **C-PR3** — wire YAML-declared `on_file_save` / `on_test_run` / `on_recipe_save` / `git_hook` into the orchestrator's automation hooks via existing `compileRecipe` → `AutomationProgram` scaffolding (Option A per PLAN-C); fix scheduler `timezone` option; fix `nestedRecipeStep` off-by-one. Closes **#3, #6, #10, #13, #28**, plus round-2 I findings (cron-installed-post-startup, nested cycle detection).
- **A-PR5** — promote `/tmp/dogfood-G2/` exploit YAMLs to `docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures/` so PR-1/2/3/4 regression tests survive `/tmp` cleanup.

Outcome: dormant trigger types become live. Cron honors per-recipe timezone. Recursion limits actually hold. Security regression tests in repo.

## Cross-bundle dependency graph

```
A-PR1 ──┐
A-PR2   │            (Phase 1 — security)
        │
        ▼
B-PR1 ──────────────┐ (Phase 2 — foundation; A-PR4 lands in parallel)
                    │
                    ├──► A-PR3+B-PR2  (Phase 4)
                    │         │
                    │         ▼
                    ├──► B-PR3       (Phase 5)
                    │         │
                    │         ▼
                    └──► B-PR4+C-PR4 (Phase 5)
                              │
                              ▼
                          C-PR3        (Phase 6 — needs B-PR1's silent-fail floor)

C-PR1 ┐
C-PR2 ├──── independent of A/B; land any time after Phase 1 (Phase 3)
C-PR5 │
C-PR6 ┘     (C-PR6 schema cap should land 1 PR before A-PR3 runtime clamp)
```

## What this closes (28 round-1 + 16 round-2 + 13 security/HTTP findings)

| Bug class | Fixed by |
|---|---|
| Path traversal in file tools (F-01, F-02, F-10, F-04) | Phase 1 (A-PR1, A-PR2) |
| SSRF + body cap (F-05, F-08) | Phase 1 (A-PR2) |
| Permissions theatre (F-03) | Phase 2 (A-PR4) |
| Cross-runner contract drift (#1, #2, #9, F-07, registrySnapshot) | Phase 2 (B-PR1) + Phase 4 (A-PR3+B-PR2) |
| Silent agent skip (#11) | Phase 2 (B-PR1) |
| Lint false-positives (#8, #23, partial #24) | Phase 3 (C-PR1) |
| CLI broken (#4, #5, #7, #17, #20, #26, #27) | Phase 3 (C-PR2) |
| Test gaps + camelCase aliases (#18, #19) | Phase 3 (C-PR5) |
| `quick-task`, `replayRun` CLI, F-09 (#21, #22) | Phase 3 (C-PR6) + Phase 4 (combined PR) |
| Atomic write race (F-06) | Phase 4 (A-PR3+B-PR2) |
| Third runner divergence + JSON shadow (#14) | Phase 5 (B-PR3, B-PR4+C-PR4) |
| PATCH ESM + missing HTTP routes (#15) | Phase 5 (B-PR4+C-PR4) |
| Trigger types dormant (#3, #6, #10, #13, #28) | Phase 6 (C-PR3) |
| Cron post-startup install + nested cycle + multi-yaml drop + duplicate-name (round-2 I) | Phase 6 (C-PR3) — folds into trigger-wiring work |
| Security regression fixtures (A-PR5) | Phase 6 |

## Maintainer decisions to make before Phase 1 ships

These are all in the underlying plans; pulled here for one-place review.

1. **F-03 permissions** (PLAN-A DP-1): delete sidecar (recommended) vs enforce. Delete is faster + matches existing `~/.claude/settings.json` story.
2. **F-05 install allowlist** (PLAN-A DP-2): strict-github vs `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS` env var. Recommend env-var-default-empty (effectively github-only out of the box).
3. **F-09 maxConcurrency cap** (PLAN-A DP-3 + PLAN-C C-PR6): 8 / 16 / 32. Recommend 16, warn above 8.
4. **#6 trigger wiring** (PLAN-C DP-1): wire to orchestrator (recommended) vs drop trigger types from schema. Wiring preserves starter-pack and matches user intent of writing recipes that trigger themselves.
5. **#8 lint whitelist** (PLAN-C DP-2): explicit 5-root set `{steps, env, vars, recipe, $result}` (recommended) vs any-dotted-path. Explicit preserves typo-detection.
6. **#15 missing routes** (PLAN-C DP-3): 4 to land, 2 to skip (`/preflight` + `/lint` — CLI canonical), 1 docs fix.
7. **#14 daily-status precedence** (PLAN-C DP-6): YAML-wins (recommended) with explicit `.json`/`.yaml` URL extension as override.
8. **#19 camelCase strategy** (PLAN-C DP-4): auto-emit in `registerTool` (recommended) — one rule, can't be forgotten.
9. **#23 dead `parser.ts`** (PLAN-C DP-5): delete (recommended).

## Risk and rollback

- Phase 1 PRs are isolated to recipe runner and HTTP route handlers — rollback by reverting one commit each.
- Phase 2 B-PR1 is the load-bearing change. **Tag `runlogVersion: 2`** as the plan specifies; old rows continue to work via the version-branched dashboard reader. Rollback safely.
- A-PR4 (delete sidecar) is destructive metadata-wise — keep migration script in PR description so users can restore from `~/.patchwork/recipes/.permissions-archive/` if they relied on those files.
- Phase 4 combined PR touches both runners — needs the most thorough test coverage (chained vs yaml parity assertions).
- Phase 5 B-PR3 deletes `loadRecipePrompt`. Run all `kind: prompt` JSON recipes through the new path in a vitest before merging.
- Phase 6 C-PR3 is the trigger-wiring change — risk is that newly-live triggers fire too aggressively. Land with cooldownMs defaults from CLAUDE.md (`min 5000`) honored; document migration for any starter-pack users.

## Test investment

PLAN-A: ~150 LoC source + 200 LoC tests across 5 PRs.
PLAN-B: ~600 LoC source + 800 LoC tests across 4 PRs.
PLAN-C: ~870 LoC source + ~1340 LoC tests across 6 PRs.

Total ~1,620 source / ~2,340 tests. **1.4:1 test:source ratio.** Each PR carries its own regression tests; no separate "test backfill" PR.

## What this plan does NOT cover

- **Connector-side wrappers** for the 7 connector tool files with no error handling (notion, confluence, zendesk, intercom, hubspot, datadog, stripe — 38 tools per Agent F). These produce throws on unauth; recipes wrap-or-die. Belongs to its own connector-hygiene plan (PLAN-D suggested) — out of scope here because root cause is connector code, not recipe code.
- **Dashboard UI changes** beyond what's required to render the new `runlogVersion: 2` shape. Dashboard already gracefully degrades per Agent E.
- **Plugin authoring docs** updates for camelCase aliases — separate docs PR.

## Schedule summary

| Phase | Week | PRs | Closes |
|---|---|---|---|
| 1 — Stop bleed | 1 | A-PR1, A-PR2 | 7 security findings |
| 2 — Foundation | 2 | B-PR1, A-PR4 | 5 runner-contract bugs + perms |
| 3 — Cleanup wins | 3 | C-PR1, C-PR2, C-PR5, C-PR6 | 13 lint/CLI/test bugs |
| 4 — Coordinated | 4 | A-PR3+B-PR2 (combined) | #1 + F-06 + F-09 |
| 5 — Resolver | 5 | B-PR3, B-PR4+C-PR4 (combined) | #14 + PATCH-ESM + 4 routes + third-runner |
| 6 — Triggers + hygiene | 6 | C-PR3, A-PR5 | #6 + #10 + #13 + cron-install + cycle-detect + fixtures |

12 PRs, 6 weeks, sequential phases. Phases 3–6 contain parallelizable sub-PRs.
