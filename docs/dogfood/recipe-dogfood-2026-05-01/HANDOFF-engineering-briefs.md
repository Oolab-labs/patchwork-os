# HANDOFF — Per-PR Engineering Briefs

One-page brief per PR in the V2 phased rollout. Engineer-ready: file pins, bug pins, test pins, decision blockers. Read-only synthesis of `PLAN-MASTER.md` + `PLAN-A-security.md` + `PLAN-B-runners.md` + `PLAN-C-schema-cli.md` + `REVIEW-1-architecture.md` + `REVIEW-2-security.md` + `REVIEW-3-completeness.md`.

Severity tags: **CRITICAL** / **HIGH** / **MED** / **LOW**.

V2 PR list (canonical):

- **Phase 1** — A-PR1, A-PR2, A-PR4 (promoted from Phase 2 by R3 amendment 1)
- **Phase 2** — B-PR1a, B-PR1b
- **Phase 3** — C-PR1, C-PR2a, C-PR2b, C-PR2c, C-PR5, C-PR6
- **Phase 4** — A-PR3+B-PR2 combined
- **Phase 5** — B-PR3, B-PR4+C-PR4 combined
- **Phase 6** — C-PR3, A-PR5

Total: 14 PRs across 6 phases.

---

## Phase 1 — Stop the bleed (security CRITICALs) — week 1

### A-PR1 — `resolveRecipePath` jail + `file.*` containment + `vars` HTTP validation

**1. Title + scope.** Install a single jail helper that resolves recipe-supplied paths against an allowlist of roots, apply it at every file-tool dispatch site (yamlRunner, chainedRunner, file.ts) and HTTP `vars` entry, with type-strict value validation.

**2. Bugs closed.** F-01 (CRITICAL — `file.read/write/append` accept arbitrary absolute paths), F-02 (CRITICAL — template-substituted vars escape via `..`), F-10 (MED — CLI no warn on out-of-jail recipe path), C-1 from R2 (CRITICAL — chained-runner third template substitution site uncovered).

**3. Files to touch.**
- `src/recipes/resolveRecipePath.ts:NEW` — jail helper, ~150 LOC. Wraps `cachedRealpathSync` ancestor-walk pattern from `src/tools/utils.ts:130-177`. Default jail roots: `~/.patchwork/`, `opts.workspace`. **`/tmp` opt-in via `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1` env var only** (per R2 C-2).
- `src/recipes/tools/file.ts:12-145` — replace `expandHome` with jail-aware resolver in all three tools.
- `src/recipes/yamlRunner.ts:976-994` — jail `readFile`/`writeFile`/`appendFile`/`mkdir` defaults.
- `src/recipes/yamlRunner.ts:642` — re-validate `render(step.path, ctx)` output after template substitution.
- `src/recipes/yamlRunner.ts:1252-1262` — jail `executeTool` wrapper at chained-runner dispatch (closes R2 C-1 third-substitution-site gap).
- `src/recipes/chainedRunner.ts:194-205` — alternative jail point for chained tool params (defense in depth).
- `src/recipeRoutes.ts:131-138`, `:172-181` — `vars` validation: keys `/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`, values match `/^[\w\-. :+@,]+$/u` (no slashes, no `..`, no `~`), type-strict string-only (closes R2 C-3 + I-3).
- `src/commands/recipe.ts:1080-1102` — CLI `console.warn` when out-of-jail.
- `src/recipes/__tests__/resolveRecipePath.test.ts:NEW`
- `src/recipes/tools/__tests__/file.test.ts:NEW` (first per-namespace tool test, closes F-tools.md F5 partial).
- `src/__tests__/recipeRoutes-vars-validation.test.ts:NEW`

**4. Approach.** Build `resolveRecipePath(p, opts)`. Reject null bytes, paths resolving outside any allowed root, hardlink escapes via `lstatSync(p).nlink > 1` on writes. Apply at tool layer (file.ts) AND dep-injection defaults (yamlRunner.ts:976-994) AND chained dispatch (yamlRunner.ts:1252) so future agent steps that import `deps.writeFile` directly are covered. HTTP `vars` validation is defense in depth: the post-render jail is the actual defense. Set `err.code = "recipe_path_jail_escape"` (R2 M-4).

**5. Regression tests required.**
- `src/recipes/__tests__/resolveRecipePath.test.ts` — null-byte path → throws; symlink escape → throws; valid in-jail → resolves; `/tmp` rejected unless env-var set.
- `src/recipes/tools/__tests__/file.test.ts` — `escapes-via-traversal.yaml` (from `/tmp/dogfood-G2/exploit-traversal.yaml`) → throws with `err.code === "recipe_path_jail_escape"`; `escapes-via-symlink.yaml` → throws; `template-traversal.yaml` (var post-render `../../../tmp/x`) → throws after render; `null-byte-path.yaml` → rejected before render; `valid-write-inside-jail.yaml` → succeeds.
- `src/__tests__/recipeRoutes-vars-validation.test.ts` — `vars: {target: "../etc"}` → 400; `vars: {"bad-key": "x"}` → 400; `vars: {ok_key: 42}` → 400 (type-strict per I-3); `vars: {ok_key: "value"}` → forwards.
- `cli-warns-when-out-of-jail.test.ts` — `recipe run /tmp/x.yaml` writes to stderr.

Round-2 finding match: F-tools F1 + R2 C-1 (chained substitution) + R2 C-3 (vars rule) + I-3 (typed values).

**6. Maintainer decisions blocking start.**
- **DP-2 (F-05 install allowlist)** — does not block A-PR1 directly, but DP-2's env-var-default-empty pattern is precedent for the `/tmp` jail env-var — confirm before merge.
- **R2 C-2 default jail roots** — confirm `/tmp` defaults OFF. Without confirmation, multi-tenant deployments are exposed.

**7. Cross-bundle dependencies.** Foundational; nothing depends on it within Phase 1. **Must land before A-PR3** (combined PR Phase 4) because both edit `yamlRunner.ts:976-994`.

**8. Estimated diff size.** ~200 LoC source / ~280 LoC tests. (Plan-A estimate ~150/200 understated chained-runner third-site coverage.)

**9. Reviewer focus areas.**
- Is the chained-runner third substitution site actually covered? (R2 C-1 — single-line claim covering structurally different paths.)
- Does the `/tmp` default match the agreed posture? (R2 C-2 — multi-tenant risk.)
- Is the `vars` regex actually deny-listing `..` and slashes? (R2 C-3 — line 36 of original plan was a no-op.)
- Tests assert `err.code`, not message strings (R2 M-4).

**10. Rollback strategy.** Single commit revert. Helper module is new; no callers outside this PR. Existing recipes that legitimately write under `~/.patchwork/inbox/` keep working; no retroactive impact.

---

### A-PR2 — `loadNestedRecipe` jail + install host allowlist + body cap

**1. Title + scope.** Restrict chained `recipe:` references to vetted directories, gate `POST /recipes/install` non-github sources behind explicit env var, cap recipe-route request bodies.

**2. Bugs closed.** F-04 (HIGH — chained `recipe:` accepts arbitrary paths), F-05 / H-SSRF (HIGH — install accepts arbitrary HTTPS URLs), F-08 (MED — recipe-route bodies unbounded), R2 H-routes Bug 2 (HIGH — 500-on-fetch-fail), R2 M-2 (MED — `parseGithubShorthand` no `owner`/`repo` validation), R2 I-2 (INFO — `httpsGet` redirect chase).

**3. Files to touch.**
- `src/recipes/yamlRunner.ts:1284-1303` (`loadNestedRecipe`) — restrict `pathLike` to `path.dirname(parentSourcePath)` OR `~/.patchwork/recipes/` OR bundled templates dir (resolved at boot per R2 M-5).
- `src/recipeRoutes.ts:600-682` (`/recipes/install`) — gate non-github sources behind `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS`; default-deny non-github; 4xx not 500 on fetch-fail; 1 MB AbortController body cap.
- `src/recipeRoutes.ts:NEW helper` — extract `readJsonBody(req, max)` with **per-route caps** (R2 M-1): install 4 KB, `/recipes/:name/run` + `/recipes/run` 32 KB, `/recipes`, `PUT/PATCH /recipes/:name`, `/recipes/lint` 256 KB.
- `src/recipeRoutes.ts:122-160, :164-210, :357-390, :392-428, :430-467, :490-530, :600-682` — replace 6 `Buffer.concat(chunks)` accumulators with helper.
- `src/commands/recipeInstall.ts:146-180` (`parseGithubShorthand`) — validate `owner`/`repo` against `/^[a-zA-Z0-9](?:[a-zA-Z0-9-._]{0,38})$/`.
- `src/commands/recipeInstall.ts:213-249` (`httpsGet`) — constrain redirect targets to allowlist; reject 302 to internal IP.
- `src/tools/utils.ts:NEW` OR `src/ssrfGuard.ts:NEW` — extract `validateSafeUrl(urlString)` shared with `sendHttpRequest.ts` (R2 I-1).
- `src/recipes/__tests__/loadNestedRecipe.test.ts:NEW`
- `src/__tests__/recipeRoutes-install.test.ts` — extend (SSRF + body cap + 404→4xx + redirect-allowlist).

**4. Approach.** For F-04, `path.resolve` candidate, `startsWith` one of three allowed bases. For F-05, match CLI shapes (`https://github.com/...`, `https://raw.githubusercontent.com/...`); other hosts opt-in via `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS` (comma-separated). Run SSRF guard from `sendHttpRequest.ts` AFTER allowlist match (R3 DP-2 sub-issue). For F-08, single helper, per-route caps, `req.destroy()`, 413.

**5. Regression tests required.**
- `loadNestedRecipe.test.ts` — `outer-chained-traversal.yaml` (`/tmp/dogfood-G2/outer-chained.yaml`) → throws; `recipe: /etc/passwd.yaml` → rejected.
- `install-ssrf-internal.test.ts` — `source: "https://169.254.169.254/..."` → 403 with `host_not_allowlisted`.
- `install-fetch-404.test.ts` — bad path → 404 (not 500).
- `install-body-cap.test.ts` — 1 MB body → 413.
- `install-redirect-allowlist.test.ts` — 302 to internal IP → reject.
- `install-shorthand-validation.test.ts` — `gh:foo@bar:bad/repo` → reject (R2 M-2).
- `recipes-name-run-cap.test.ts` — 300 KB body → 413.
- `install-allowlist-env.test.ts` — env-var allows specific host; without env var → 403.

Round-2 finding match: G-security F-04 / F-05 / F-08 + R2 M-1 (per-route caps) + R2 M-2 (shorthand) + R2 I-2 (redirects).

**6. Maintainer decisions blocking start.**
- **DP-2 (F-05 install allowlist)** — strict github-only vs configurable env var. Plan recommends configurable; confirm.
- **R2 M-5 bundled-templates path** — concrete resolution (`path.resolve(__dirname, '../templates/recipes')` or via `require.resolve`). Captured at bridge boot, hard-coded as third jail root.

**7. Cross-bundle dependencies.** Independent of A-PR1; can ship in parallel. Both touch `recipeRoutes.ts` body parsing — coordinate to avoid merge conflict on the helper extraction.

**8. Estimated diff size.** ~280 LoC source / ~250 LoC tests. (Plan-A estimate did not include redirect allowlist + shorthand validation + per-route caps.)

**9. Reviewer focus areas.**
- Per-route caps applied (not flat 256 KB) — R2 M-1.
- SSRF guard runs AFTER env-var allowlist match — R3 DP-2 sub-issue.
- `httpsGet` redirect targets validated against same allowlist — R2 I-2.
- `parseGithubShorthand` rejects `@`-userinfo and `:`-port-injection — R2 M-2.
- Shared SSRF helper (`validateSafeUrl`) used by both call sites — prevents drift.

**10. Rollback strategy.** Two-commit revert (helper extraction + route changes). Existing dashboard "Install from URL" UX may regress for users who typed arbitrary URLs; document workaround (set env var) in PR description.

---

### A-PR4 — Permissions sidecar deletion (Option B) — **PROMOTED FROM PHASE 2**

**1. Title + scope.** Stop generating `*.permissions.json` sidecars at install time; document `~/.claude/settings.json` as canonical permissions location; emit one boot-time deprecation warning per stale sidecar count.

**2. Bugs closed.** F-03 (CRITICAL — permissions theatre), R3 amendment 1 (Phase 1 doesn't actually stop the bleed without F-03).

**3. Files to touch.**
- `src/recipes/installer.ts:91-97` — delete sidecar write.
- `src/recipes/installer.ts:NEW boot hook` OR `src/server.ts:startup` — once-per-boot scan of `~/.patchwork/recipes/*.permissions.json`, emit single `console.warn` with count + migration URL (R2 L-2). Skip in `NODE_ENV=test`.
- `src/recipesHttp.ts:582,689,707` — remove `hasPermissions` field generation in `/recipes` list response. Dashboard treats missing field as `false`.
- `dashboard/src/...` — copy change: "Patchwork does not enforce per-recipe permissions; configure tool gating in `~/.claude/settings.json`" (R3 DP-1 mitigation).
- `src/__tests__/installer-no-permissions.test.ts:NEW` — `installRecipeFromFile` does NOT create `<entry>.permissions.json`.
- `src/__tests__/server-recipes-no-perms-field.test.ts:NEW` — GET `/recipes` response shape no longer carries `hasPermissions`.

**4. Approach.** Stop generating sidecar. Existing files on disk left alone (one-time warning). Document in `documents/platform-docs.md` permissions section. The R3-flagged failure scenario (operator audits dashboard, can't tell "no permissions ever existed" from "permissions deleted as policy") is mitigated by the dashboard copy change.

**5. Regression tests required.**
- `installer-no-permissions.test.ts` — install a recipe; assert no sidecar file created.
- `server-recipes-no-perms-field.test.ts` — assert `/recipes` response items don't carry `hasPermissions`.
- `boot-warning-test.ts` — seed `~/.patchwork/recipes/foo.permissions.json`; boot bridge; assert single `console.warn` with count.

Round-2 finding match: G-security F-03 + R2 L-2 (warning emission detail).

**6. Maintainer decisions blocking start.**
- **DP-1 (F-03 enforce vs delete)** — must commit to Option B before this PR ships. R3 challenges this with a Third Option (delete + 30-line enforcement). Maintainer must pick one of three before kickoff.
- **DP-7 sub-issue** — if Option B ships, drop `POST /recipes/:name/permissions` from C-PR4 land set (R3 DP-7 inconsistency).

**7. Cross-bundle dependencies.** Independent of A-PR1, A-PR2. Ships same week. R3 amendment: must land Phase 1 to make "stop the bleed" honest.

**8. Estimated diff size.** ~50 LoC source / ~80 LoC tests + ~10 LoC dashboard copy.

**9. Reviewer focus areas.**
- Boot warning fires once, not per-recipe (R2 L-2).
- Dashboard copy explicitly states permissions are not enforced (R3 mitigation).
- Migration script preserved in PR description (PLAN-MASTER:133).

**10. Rollback strategy.** Single-commit revert restores sidecar generation. Sidecar files survived on disk during Option B period — no data loss.

---

## Phase 2 — Architectural foundation — week 2

### B-PR1a — Post-step pipeline extraction (no shape change)

**1. Title + scope.** Extract `stepObservation.ts` module, wire silent-fail + JSON-error short-circuit + classification into both yamlRunner and chainedRunner, populate VD-2 fields in yamlRunner. **Keep `registrySnapshot` as full snapshot** — no dashboard-readable shape change.

**2. Bugs closed.** #2 (HIGH — `detectSilentFail` in chained), #9 (HIGH — VD-2 in yamlRunner), #11 chained-half (HIGH — silent agent skip), half of #1 (HIGH — chained writes get tagged `isWrite`). R1 amendment A1 (split B-PR1 to isolate dashboard-breaking change).

**3. Files to touch.**
- `src/recipes/stepObservation.ts:NEW` — exports `observeStep`. Public surface per PLAN-B-runners.md:241-266. ~150 LOC.
- `src/recipes/yamlRunner.ts:540-621` (tool branch) — replace inline silent-fail + JSON-err logic with `observeStep` call.
- `src/recipes/yamlRunner.ts:450-529` (agent branch) — parallel branch with separate silent-fail at `:469-471`; replace with `observeStep` call (R1 §Q1a — 2-yaml-branch + 1-chained-seam = 3 wiring points, not 2).
- `src/recipes/yamlRunner.ts:668-674` — populate VD-2 fields in `finalStepResults` (output, resolvedParams, startedAt).
- `src/recipes/chainedRunner.ts:438-471` — wrap `executeAgent`/`executeTool` returns through `observeStep`. Replace `success: true` shortcut.
- **Critical ordering note** (R1 R1, A2): `observeStep` MUST run AFTER inner execution but BEFORE `chainedRunner.ts:820-829` `registry.set`. Use synthetic post-step snapshot computed from `prevRegistry + {stepId: result.data}`. Avoids parallel-branch race + registry-write-ordering bug.
- `src/recipes/__tests__/stepObservation.test.ts:NEW`
- `src/recipes/__tests__/yamlRunner-vd2.test.ts:NEW`
- `src/recipes/__tests__/chainedRunner-silentfail.test.ts:NEW`

**4. Approach.** Pure post-step seam. Both runners call `observeStep` after inner execution, before result-write. Inner mechanics (sequential vs parallel) untouched. Status-mutation flows: silent-fail-detected step gets `error` status BEFORE `registry.set`, so downstream templates see corrected data.

**5. Regression tests required.**
- T1 (chained silent-fail): mock `executeTool` returns `(git branches unavailable)` → step status `error`, `errorMessage` includes `silent-fail detected`. Closes #2 chained-half.
- T2 (yaml VD-2): `morning-brief`-clone fired through `runYamlRecipe` → `stepResults[i].output !== undefined`, `resolvedParams !== undefined`, `startedAt > 0`. Closes #9.
- T4 (yaml JSON-err preserved): tool returns `{ok:false, error:"x"}` → classify `error`. Existing yamlRunner behavior preserved.
- T5 (chained agent silent-skip): `executeAgent` returns `[agent step skipped: …]` → flips to `error`. Closes #11 chained-side.
- T6 (registry-write ordering): silent-fail-detected step's `data` does NOT propagate to subsequent steps' `{{steps.X.data}}` templates (R1 R1 verification).
- T7 (parallel-branch race): two concurrent steps in chained runner → each step's `registryDelta` only contains its own writes, not the other's (R1 §Q1c).

Round-2 finding match: F3 (chained silent-fail) + F-tools F5 (chained capture) + I-e2e #7 (yamlRunner VD-2).

**6. Maintainer decisions blocking start.**
- **R1 A2 ordering decision** — confirm `observeStep` runs BEFORE `registry.set`. Without confirmation, silent-fail label appears but downstream still sees bad data.
- **F-tools F6/F7/F8** (R3 amendment 5) — should `detectSilentFail` be generalized to catch `linear.createIssue` bare `{error}` envelope? If yes, expand scope. If no, document as out-of-scope and add to follow-up PR-D (connector hygiene).

**7. Cross-bundle dependencies.** Foundational for B-PR3 (B-PR3 needs VD-2 + silent-fail in yaml for synthesized recipe to inherit). Independent of B-PR1b.

**8. Estimated diff size.** ~500 LoC source / ~400 LoC tests across 4 files. (R3 reality check: original B-PR1 = ~1,000 LoC; split halves it.)

**9. Reviewer focus areas.**
- 3 wiring points covered (yaml-tool, yaml-agent, chained) — R1 §Q1a.
- `observeStep` runs BEFORE `registry.set` in chained — R1 R1, A2.
- Parallel-branch delta computation isolated per-step — R1 §Q1c.
- Double-truncation risk if `captureForRunlog` re-applied — R1 §Q2 last paragraph.

**10. Rollback strategy.** Single-commit revert. New module (`stepObservation.ts`) deletable. Both runners' inline logic preserved in git history; revert restores. **No dashboard impact** because shape is unchanged in B-PR1a.

---

### B-PR1b — `registrySnapshot` delta + `runlogVersion: 2` + dashboard reader

**1. Title + scope.** Convert per-step `registrySnapshot` to delta semantics, add run-level `registryFinalSnapshot`, tag new rows `runlogVersion: 2`, ship dashboard branch reader for v1-vs-v2 distinction.

**2. Bugs closed.** #25 (HIGH — `registrySnapshot` per-step bloat), R2 H-routes Bug 4 (HIGH). R1 amendment A1 (isolates dashboard-breaking change from silent-fail floor).

**3. Files to touch.**
- `src/recipes/captureForRunlog.ts:NEW captureRegistryDelta(prevSnapshot, currentSnapshot)` — ~50 LOC.
- `src/recipes/chainedRunner.ts:836-855` — replace per-step full-snapshot with delta capture.
- `src/runLog.ts:34-53` — add optional `registryFinalSnapshot?: Record<string, unknown>` AND `runlogVersion?: 1 | 2` field.
- `src/runLog.ts:NEW writer` — emit `runlogVersion: 2` on new rows.
- `dashboard/src/lib/registryDiff.ts:142-168` — branch reader: if `runlogVersion === 2`, accumulate deltas left-to-right OR walk backward from `registryFinalSnapshot`. If `runlogVersion === 1` (or missing), use existing snapshot-vs-snapshot diff path (R1 §Q2 — currently no version-branch hook; this PR adds it).
- `dashboard/src/app/runs/[seq]/page.tsx:21-45` — interface update for new fields.
- `src/__tests__/runlogV2.test.ts:NEW` — round-trip tests (v1-only, v2-only, mixed-row file — R3 §6 §7 — 3+ tests not 1).
- `dashboard/src/__tests__/registryDiff.test.ts` — extend with v1+v2 fixtures.

**4. Approach.** Delta scales per-step storage with actual writes (typically 1-2 keys → bytes). One run-level snapshot for replay/dashboard. Branch dashboard reader by `runlogVersion`. Old chained-runner rows pre-dating B-PR1b carry full snapshots without the version field — reader treats missing version as v1.

**5. Regression tests required.**
- T3 (delta storage): chained 4-step recipe (write at end) → `RecipeRun.registryFinalSnapshot` ≈ 25 KB ONCE; sum of `stepResults[i].registrySnapshot` (delta) bytes < 5 KB.
- T8 (round-trip v1): old runs.jsonl row without `runlogVersion` → dashboard renders correctly via v1 path.
- T9 (round-trip v2): new row with `runlogVersion: 2` → dashboard renders correctly via v2 delta-walk.
- T10 (mixed file): runs.jsonl with both v1 and v2 rows → all render correctly.
- T11 (replayRun preserved): chained run with v2 → `replayRun` reads `step.output` unchanged (R1 §Q2).
- T12 (ctxQueryTraces body shape): `body.stepResults[i].registrySnapshot` returned as delta — caller documented (R1 B4).

Round-2 finding match: I-e2e #14 (registrySnapshot duplicated) + R1 R2 (dashboard reader gap) + R1 §Q2 ctxQueryTraces.

**6. Maintainer decisions blocking start.**
- **R1 A1 split confirmed** — B-PR1a + B-PR1b ships as two PRs (already implicit in V2 list).
- **Dashboard ship-coupling** — bridge alpha tagged with v2-format; dashboard updated same release. Without dashboard reader, dashboard renders wrong diffs for new runs. Coordinate release notes.
- **`ctxQueryTraces` body-shape exposure** (R1 B4) — accept as documented-but-unmasked, or add masking layer? Current plan: documented-but-unmasked.

**7. Cross-bundle dependencies.** Depends on B-PR1a (shared post-step pipeline foundation). Independent of B-PR3, B-PR4. Dashboard shipping atomically with bridge prevents broken-diff window.

**8. Estimated diff size.** ~350 LoC source (bridge ~250 + dashboard ~100) / ~250 LoC tests. (R3 §4.2: original B-PR1 1,000 LoC; this is the dashboard-half ~350.)

**9. Reviewer focus areas.**
- 3+ round-trip tests cover v1-only, v2-only, mixed file (R3 §6 §7).
- `registryFinalSnapshot` cap stays in place as safety net.
- Dashboard reader correctly identifies v1 vs v2 (missing field → v1).
- `replayRun` works against v2 rows (R1 §Q2 — currently rejects yaml-runner replays; this is incidental fix, document but don't promise unlock).

**10. Rollback strategy.** Bridge-side revert restores full-snapshot semantics for new rows. v2 rows already on disk continue rendering via v2 reader path. **Dashboard revert ALONE is not safe** if bridge already wrote v2 rows — pair revert. Tag both packages with the runlogVersion bump.

---

## Phase 3 — Cleanup wins — week 3 (parallelizable)

### C-PR1 — Lint root whitelist + delete `parser.ts` + template builtins

**1. Title + scope.** Add 5-root reserved whitelist `{steps, env, vars, recipe, $result}` to `validateTemplateReferences`; delete dead `parser.ts`; seed built-in template keys (`YYYY-MM-DD`, `YYYY-MM`, `ISO_NOW`) in both runners and template engine.

**2. Bugs closed.** #8 (HIGH — 100% lint false-positive on `{{steps.X.data}}` style), #23 (LOW — dead `parser.ts`), partial #24 (LOW — `output:` warning quieted via dedup). Built-ins gap from D-templates #3.

**3. Files to touch.**
- `src/recipes/validation.ts:356-364` — `RESERVED_TEMPLATE_ROOTS = new Set(["steps","env","vars","recipe","$result"])`.
- `src/recipes/validation.ts:392-405` (`validateTemplateReferences`) — short-circuit when root in whitelist.
- `src/recipes/validation.ts:501-524` (`extractTemplateDottedPaths`) — caller applies whitelist.
- `src/recipes/parser.ts:DELETE` — entire file.
- `src/recipes/__tests__/parser.test.ts:DELETE-OR-REWRITE` — coverage shifts to `legacyRecipeCompat.test.ts` (R3 DP-9 verify edge cases).
- `src/recipes/compiler.ts:1` — drop `parser.ts` import.
- `src/recipes/yamlRunner.ts:407-412` — seed `YYYY-MM-DD`, `YYYY-MM`, `ISO_NOW` in ctx.
- `src/recipes/templateEngine.ts:117-133` — extend `parseExpression` to recognize 5 bare-identifier built-ins (whitelist; do not open arbitrary bare idents).
- `src/recipes/__tests__/validation.lintParity.test.ts:NEW`
- `src/recipes/__tests__/templateEngine.test.ts` — extend.

**4. Approach.** 5-root whitelist preserves typo detection (`{{steeps.X.data}}` → typo `steeps` not in set, still rejected). Built-ins seeded in both runtime AND template engine grammar so chained + yaml render bare references.

**5. Regression tests required.**
- `validation.lintParity.test.ts`: `branch-health.yaml` snapshot → 0 errors after fix (was 6); `triage-brief.yaml` → 0 errors (was 5); `{{steps.stale.data}}` accepted; `{{env.HOME}}` accepted; `{{step.stale.data}}` (typo) still rejected; `{{steps.stale}}` (root-only, no field) accepted.
- `templateEngine.test.ts` — `{{YYYY-MM-DD}}` renders; `{{ISO_NOW}}` renders; bare ident outside the 5 → still rejected.

Round-2 finding match: round-1 #8 + #23 + D-templates #3.

**6. Maintainer decisions blocking start.**
- **DP-5 (lint whitelist explicit 5-root)** — confirm. R3 sub-issue: verify `$result` is actually a runtime root by grepping `templateEngine` + `yamlRunner`. If not exposed, drop to 4-root set.
- **DP-9 (`parser.ts` delete)** — confirm.
- **R1 §C2 cross-runner asymmetry** — chained recipes use `steps.X.data`; yamlRunner does NOT seed `steps`/`env` in flat ctx. Document the asymmetry persists (lint accepts both; runtime renders depend on runner).

**7. Cross-bundle dependencies.** Independent. Can ship Phase 3 in parallel with C-PR2*, C-PR5, C-PR6.

**8. Estimated diff size.** ~100 LoC source / ~80 LoC tests across 5 files.

**9. Reviewer focus areas.**
- `$result` actually exists in runtime (R3 DP-5 sub-issue).
- `parser.ts` deletion didn't strand `renderTemplate` callers (only `__tests__/`, `compiler.ts:1`).
- Cross-runner template-engine asymmetry documented (R1 C2).
- Built-in idents whitelisted (no arbitrary bare ident grammar opening).

**10. Rollback strategy.** Single-commit revert. `parser.ts` restorable from git history; dependent test file restorable.

---

### C-PR2a — `recipe list` + `recipe run <name>` enumeration parity

**1. Title + scope.** Widen `listInstalledRecipes` walker to enumerate top-level YAML/JSON files; resolve `recipe run <name>` against subdir + manifest-dir layouts.

**2. Bugs closed.** #4 (HIGH — `recipe list` 1-of-N shown), #17 (MED — `recipe run <name>` can't reach subdir recipes).

**3. Files to touch.**
- `src/commands/recipeInstall.ts:667-720` (`listInstalledRecipes`) — branch on `statSync(...).isDirectory()`: dirs use existing manifest-first logic; top-level files synthesize `InstalledRecipeEntry`.
- `src/commands/recipe.ts` — `recipe run <name>` resolver: also check `~/.patchwork/recipes/*/<name>.{yaml,yml,json}` (one level deep) and `~/.patchwork/recipes/<name>/main.{yaml,yml,json}`. Use `listInstalledRecipes()` as source of truth.
- `src/commands/__tests__/recipeInstall.list.test.ts:NEW` — 4 fixtures (top-level YAML, top-level JSON, manifest dir, namespaced subdir).

**4. Approach.** Port the HTTP `/recipes` walker (`recipesHttp.ts:213+`) — don't re-implement. CLI + dashboard share the same enumeration logic.

**5. Regression tests required.**
- `recipeInstall.list.test.ts`: list returns 4 entries (one per fixture).
- `recipe-run-subdir.test.ts`: namespace/recipe.yaml fixture → `recipe run namespace/recipe` resolves.

Round-2 finding match: round-1 #4 + #17 + I-e2e #6 partial (multi-yaml drop) — note R1 §Q6 #6 says I-e2e finding is about INSTALL/REGISTRY one-per-dir, NOT LIST; this PR fixes the LIST half. Registry-side fix is in C-PR3 scope (R3 amendment 2).

**6. Maintainer decisions blocking start.**
- None.

**7. Cross-bundle dependencies.** Independent. Parallel with C-PR2b, C-PR2c, C-PR1, C-PR5, C-PR6.

**8. Estimated diff size.** ~150 LoC source / ~120 LoC tests across 3 files.

**9. Reviewer focus areas.**
- HTTP `/recipes` walker reused, not re-implemented (drift risk).
- Subdir resolution one level deep, not unbounded recursion.

**10. Rollback strategy.** Single-commit revert. Existing CLI behavior preserved; users with subdir recipes lose subdir resolution but retain top-level.

---

### C-PR2b — `recipe new` template + dash-prefix guard + help text

**1. Title + scope.** Quote description in scaffold template; reject recipe names starting with `-`; emit help text on bare `recipe`.

**2. Bugs closed.** #7 (MED — `recipe new` template fails own lint), #20 (MED — `recipe new --help` makes `--help.yaml`), #26 (LOW — `recipe`/`recipe --help` silent).

**3. Files to touch.**
- `src/index.ts:1228` — change `Recipe: ${recipeName}` to `Recipe ${recipeName}` (no colon).
- `src/commands/recipe.ts:runNew` — quote description in template render.
- `src/index.ts:1203` — guard: `if (!recipeName || recipeName.startsWith("-"))` → stderr + exit 1.
- `src/index.ts:174-180` — handler for `recipe` alone OR `recipe --help`/`recipe -h` → print subcommand list. Tested via `array of {cmd, summary}`.
- Apply dash guard to `recipe enable/disable/uninstall <name>` branches.
- `src/commands/__tests__/recipe.new.test.ts` — extend: `runNew({name})` then `validateRecipeDefinition` → 0 errors.
- `src/__tests__/recipe-cli.integration.test.ts` — extend: `recipe new --help` exits 1, no file; `recipe` alone exits 0 with non-empty stdout.

**4. Approach.** Trivial CLI hygiene. No dispatch changes.

**5. Regression tests required.**
- `recipe.new.test.ts` — scaffolded recipe passes own validator.
- `recipe-cli.integration.test.ts` — `recipe new --help` produces no `--help.yaml`; `recipe` alone prints help.

Round-2 finding match: round-1 #7 + #20 + #26.

**6. Maintainer decisions blocking start.**
- None.

**7. Cross-bundle dependencies.** Independent. Parallel.

**8. Estimated diff size.** ~120 LoC source / ~100 LoC tests across 4 files.

**9. Reviewer focus areas.**
- Dash guard applied uniformly across `enable/disable/uninstall/new`.
- Help text terse (under 40 lines).

**10. Rollback strategy.** Single-commit revert.

---

### C-PR2c — Dedup deprecation warnings + install-time preflight + dry-run exit code

**1. Title + scope.** Add per-process `Set<string>` to dedup `(file, warning-id)` pairs; preflight YAML parse on install; fix `recipe run --dry-run` exit 0 on lint errors.

**2. Bugs closed.** #27 (LOW — apiVersion warning 3×), half of #5 (MED — install accepts malformed YAML), B-cli #31 (round-1 dropped — dry-run exit code).

**3. Files to touch.**
- `src/recipes/legacyRecipeCompat.ts:140-180` — `warn(file, id, message)` signature; per-process Set keyed by `(file, id)`. Export `__resetWarnDedup` for tests.
- `src/recipes/migrations/*` — thread through new `warn` signature.
- `src/commands/recipeInstall.ts` — install-time `validateRecipeDefinition` walk before copy. Abort with non-zero exit on parse errors. Warnings stay non-fatal.
- `src/commands/recipe.ts` — `recipe run --dry-run` exit code: if `lint.errors` populated → exit 1.
- `src/recipes/__tests__/legacyRecipeCompat.dedup.test.ts:NEW` — three loads → exactly one apiVersion warning per `(file, id)`.
- `src/commands/__tests__/recipeInstall.preflight.test.ts:NEW` — install dir with one good + one broken YAML → exit 1, neither file copied.
- `src/__tests__/recipe-dryrun-exit.test.ts:NEW` — recipe with lint error + `--dry-run` → exit 1.

**4. Approach.** Per-process Set, reset helper for tests. Preflight walks source dir, runs validator, errors abort. Dry-run exit code: simple branch on `result.lint.errors.length > 0`.

**5. Regression tests required.**
- `legacyRecipeCompat.dedup.test.ts` — 3 loads, 1 warning per (file, id).
- `recipeInstall.preflight.test.ts` — broken YAML aborts install.
- `recipe-dryrun-exit.test.ts` — closes B-cli #31 (R3 amendment 7).

Round-2 finding match: round-1 #27 + half of #5 + R3 round-1-dropped (B-cli #31).

**6. Maintainer decisions blocking start.**
- None. (R3 amendment 7 confirms B-cli #31 should land here.)

**7. Cross-bundle dependencies.** Independent. Parallel.

**8. Estimated diff size.** ~150 LoC source / ~120 LoC tests across 5 files.

**9. Reviewer focus areas.**
- Dedup Set reset between vitest tests (`__resetWarnDedup` helper called).
- Preflight warnings remain non-fatal (preserves legacy install path).
- Dry-run exit code change documented as user-visible behavior.

**10. Rollback strategy.** Single-commit revert. Dedup is purely additive; revert restores duplicate warnings (annoying but not broken).

---

### C-PR5 — CamelCase auto-emit + Jira/Sentry tests

**1. Title + scope.** Auto-emit camelCase aliases in `registerTool` for any snake_case tool id; add unit tests for PR #93 Jira (6 tools) + Sentry (1 tool).

**2. Bugs closed.** #18 (MED — PR #93 untested), #19 (MED — only 2/36 alias pairs shipped from PR #103), F-tools F4 + F9.

**3. Files to touch.**
- `src/recipes/toolRegistry.ts:117` (`registerTool`) — central alias-emission helper. ~10 LOC.
- `src/recipes/tools/linear.ts:99-101`, `src/recipes/tools/slack.ts:98-101` — remove manual aliasing (now redundant; auto-emit covers them).
- `src/recipes/tools/__tests__/jira.test.ts:NEW` — 6 tools × 3 cases (happy, unauth, validation) ≈ 24 tests.
- `src/recipes/tools/__tests__/sentry.test.ts:NEW` — 1 tool × 3 cases ≈ 5 tests.
- `src/recipes/tools/__tests__/aliases.test.ts:NEW` — property test: every snake_case tool has matching camelCase alias.

**4. Approach.** Single rule in `registerTool`:
```
if (def.id.includes("_") && !def.id.startsWith("_")) {
  const camelId = def.id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (camelId !== def.id) registry.set(camelId, def);
}
```
Property test prevents alias collision (R3 DP-8 sub-issue: two tools `foo_bar` + `fooBar` both register, one wins silently — assert no collision).

**5. Regression tests required.**
- `jira.test.ts` — happy / unauth / validation per tool.
- `sentry.test.ts` — happy / unauth / missing args.
- `aliases.test.ts` — property test + spot tests for full 36-pair matrix from F-tools.md§4.
- Collision test: assert no two tools collide on camelCase form (R3 DP-8).

Round-2 finding match: F-tools F4 + F5 + F9.

**6. Maintainer decisions blocking start.**
- **DP-4 (camelCase strategy auto-emit)** — confirm. R3 DP-8 sub-issue: collision property test required.

**7. Cross-bundle dependencies.** Independent. Parallel.

**8. Estimated diff size.** ~30 LoC source / ~600 LoC tests across 4 files. Test-heavy.

**9. Reviewer focus areas.**
- Property test catches alias collisions.
- Removed manual aliasing in `linear.ts` + `slack.ts` (redundant after auto-emit).
- Edge cases (`tool_v2` → `toolV2`, `_prefixed` skipped).

**10. Rollback strategy.** Single-commit revert. Aliases additive; revert removes camelCase access for snake_case tools (recipes using camelCase break).

---

### C-PR6 — Schema `maxConcurrency` cap + `replayRun` CLI + `quick-task` try/catch

**1. Title + scope.** Add lint error for `maxConcurrency` above cap; ship `patchwork recipe replay <seq>` CLI; wrap `quick-task` fetch in try/catch.

**2. Bugs closed.** #21 (LOW — `quick-task` raw `DOMException`), #22 (MED — `replayRun` no CLI), F-09 schema-side (lint-side cap one PR ahead of A-PR3 runtime clamp).

**3. Files to touch.**
- `src/commands/task.ts:174-181` — try/catch around fetch; map `AbortError`/`TimeoutError` to clean error message.
- `src/commands/recipeReplay.ts:NEW` — CLI shim around `replayMockedRun`. Posts to `POST /runs/:seq/replay` if bridge reachable; falls back to direct import on `--local`.
- `src/index.ts` — wire `replay` subcommand.
- `src/recipes/validation.ts` — add lint error for `trigger.maxConcurrency > MAX_CONCURRENCY` (constant from new `src/recipes/limits.ts:NEW MAX_CONCURRENCY = 16`).
- `src/recipes/manifestSchema.json` — same cap if expressed in JSON Schema.
- `src/commands/__tests__/task.timeout.test.ts:NEW`
- `src/commands/__tests__/recipe.replay.test.ts:NEW`
- `src/recipes/__tests__/validation.maxConcurrency.test.ts:NEW`

**4. Approach.** Three independent surfaces. Schema cap shared via `src/recipes/limits.ts` constant — A-PR3 imports same constant for runtime clamp (PLAN-MASTER:11 coordination point).

**5. Regression tests required.**
- `task.timeout.test.ts` — mock fetch reject AbortError → exit 1, single-line error.
- `recipe.replay.test.ts` — CLI delegates to HTTP when bridge present; direct import on `--local`.
- `validation.maxConcurrency.test.ts` — `maxConcurrency: 9999` produces lint error; `100` is fine; `16` is fine.

Round-2 finding match: round-1 #21 + #22 + G-security F-09 schema-half.

**6. Maintainer decisions blocking start.**
- **DP-3 (`maxConcurrency` cap value)** — 8/16/32. Plan picks 16. R3 §DP-3 sub-issue: bridge-wide cap not addressed (per-recipe only). Document in PR description.

**7. Cross-bundle dependencies.** **Schema cap MUST land before A-PR3** (PLAN-MASTER:11) so authors see lint warnings before runtime clamp activates. Parallel with other Phase 3 PRs.

**8. Estimated diff size.** ~80 LoC source / ~80 LoC tests across 4 files.

**9. Reviewer focus areas.**
- Shared `MAX_CONCURRENCY` constant exported from `src/recipes/limits.ts`.
- `replay` CLI delegates correctly between HTTP and direct paths.

**10. Rollback strategy.** Single-commit revert. Lint cap removal lets bad recipes through (until A-PR3 runtime clamp catches them).

---

## Phase 4 — Coordinated runner fixes — week 4

### A-PR3+B-PR2 (combined) — Chained `tool` field + atomic write + `maxConcurrency` runtime clamp + `maxDepth` clamp + cycle detection

**1. Title + scope.** Generate-execution-plan emits `tool`/`into`/`recipe` fields; `enrichStepFromRegistry` recurses through nested recipes for write-tagging; `writeFile` default uses `tmp + renameSync`; `maxConcurrency` clamped at 16 reading shared constant; `maxDepth` clamped at 5; runtime cycle detection on nested recipe stack.

**2. Bugs closed.** #1 (HIGH — chained `hasWriteSteps:false`; full fix split across plan + recursion halves), F-06 (HIGH — concurrent runs race-overwrite), F-07 (HIGH — same as #1 from security side), F-09 (MED — runtime half), R2 H-1 (HIGH — `maxDepth` not clamped + runtime cycle detection missing), R2 H-2 (HIGH — temp-file cleanup), R2 M-3 (MED — cross-recipe cycle detection).

**3. Files to touch.**
- `src/recipes/chainedRunner.ts:1029-1036` (`generateExecutionPlan`) — emit `tool: s.tool`, `into: s.into`, `recipe: s.recipe ?? s.chain` per plan step. Tighten return type.
- `src/commands/recipe.ts:803-822` (`enrichStepFromRegistry`) — when `step.type === "recipe"`, recursively load nested via `loadNestedRecipe`, recurse `enrichStepFromRegistry`, OR `isWrite`. Cap recursion at `maxDepth`.
- `src/commands/recipe.ts:874-883` — tighten cast (`tool`/`into` now safe).
- `src/recipes/yamlRunner.ts:976-994` — `tmp + renameSync` for `writeFile`. `tmp = ${target}.tmp.${pid}.${Date.now()}.${randomUUID().slice(0,8)}`.
- `src/recipes/yamlRunner.ts:1371` AND `src/recipes/replayRun.ts:111` AND `src/recipes/chainedRunner.ts` — clamp `maxConcurrency ?? 4` to `Math.min(value, MAX_CONCURRENCY)` from `src/recipes/limits.ts`. `console.warn` if declared > 8.
- `src/recipes/yamlRunner.ts:1372` — clamp `maxDepth ?? 3` to `Math.min(value, 5)` (R2 H-1).
- `src/recipes/chainedRunner.ts:NEW runtime cycle detection` — thread `Set<string>` of visited absolute recipe paths through `runChainedRecipe` recursion. On entry, check `recipePath` in set; reject re-entry. Same pattern in `enrichStepFromRegistry` (R2 M-3).
- `src/server.ts:startup` — startup-time temp-file sweeper: scan `~/.patchwork/inbox/`, `~/.patchwork/journal/`, `~/.patchwork/runs/` for `*.tmp.<pid>.*` where `<pid>` is no longer alive; delete (R2 H-2). Alternative: `~/.patchwork/.tmp/` shared dir.
- `src/recipes/__tests__/chainedRunner-plan.test.ts:NEW`
- `src/recipes/__tests__/concurrentRun.test.ts:NEW`
- `src/recipes/__tests__/chainedRecipeWrites.test.ts:NEW`
- `src/recipes/__tests__/cycleDetection.test.ts:NEW`
- `src/recipes/__tests__/maxConcurrencyClamp.test.ts:NEW`
- `src/__tests__/tempFileCleanup.test.ts:NEW`

**4. Approach.** Single combined PR because A-PR3 and B-PR2 share `chainedRunner.ts:991-1040` touchpoints. Per-recipe write-detection and write-atomicity are coupled because `hasWriteSteps` semantics inform approval gating and concurrent runs share output paths. Shared `MAX_CONCURRENCY` constant from `src/recipes/limits.ts`. Cycle detection at runtime, NOT just dry-run plan (R2 M-3 — PLAN-A:120 was wrong about existing topological detector).

**5. Regression tests required.**
- T6 (chained writes plan field): chained recipe with `file.write` step → `runRecipeDryPlan` returns `hasWriteSteps:true`. Closes #1.
- T7 (chained no writes): chained recipe with no writes → `hasWriteSteps:false`.
- T13 (atomic write): 5 parallel `runYamlRecipe` calls writing same path → no caller observes partial-content file; all 5 final outputs well-formed.
- T14 (chained recipe write recursion): outer chained calls inner-write recipe → `hasWriteSteps: true`.
- T15 (chained recipe readonly recursion): outer calls read-only inner → `hasWriteSteps: false`.
- T16 (cycle protection): recipe A calls B, B calls A → dry-run completes, runtime rejects with cycle error (R2 H-1).
- T17 (`maxConcurrency` clamp): recipe with `maxConcurrency: 1000` runs at ≤16.
- T18 (`maxConcurrency` warn): recipe with `maxConcurrency: 12` emits one warning to stderr.
- T19 (`maxDepth` clamp): recipe with `maxDepth: 100` clamped to 5 (R2 H-1).
- T20 (temp-file sweeper): kill process mid-write; restart bridge; assert no `.tmp.<pid>.*` files remain (R2 H-2).
- T21 (atomic write same-FS): write to `~/.patchwork/inbox/foo`; verify EXDEV does not fire (R3 §7 hidden assumption).

Round-2 finding match: round-1 #1 + G-security F-06/F-07/F-09 + R2 H-1/H-2/M-3 + I-e2e #3 (cycle detection — R3 amendment 2).

**6. Maintainer decisions blocking start.**
- **DP-3 (maxConcurrency 8/16/32)** — must be settled before C-PR6 ships (and this PR shares the constant).
- **R2 H-3 (fileLock recommendation)** — PLAN-A says fileLock is a 5-line addition for stronger guarantee. R2 says fileLock is in-process only — does NOT serialize across bridge subprocess + concurrent CLI. Maintainer must either strike fileLock from DP-3 OR replace with cross-process lock (`proper-lockfile`).
- **R2 H-2 temp-file cleanup location** — `~/.patchwork/.tmp/` shared dir vs target-dir-relative (`${target}.tmp...`)? Plan-A picks target-relative (same-FS guarantee). Confirm.

**7. Cross-bundle dependencies.** Depends on **A-PR1** (yamlRunner.ts:976-994 touchpoint). Depends on **C-PR6** (shared `MAX_CONCURRENCY` constant). Independent of B-PR1a/B-PR1b — R1 §Q5 confirms Phase 4 doesn't actually need `stepObservation`. Could land Phase 3 if maintainer accepts R1's "Phase 3b" amendment.

**8. Estimated diff size.** ~400 LoC source / ~500 LoC tests across 8 files. (R3 §3.3: combined PR is 50% larger than either alone — largest in Phase 4.)

**9. Reviewer focus areas.**
- Plan-step shape unified between `generateExecutionPlan` and `buildSimpleRecipeDryRunSteps`.
- `enrichStepFromRegistry` recursion bounded by `maxDepth` (default 3, hard cap 5).
- Atomic write same-FS assertion (target-relative tmp path).
- Cycle detection at RUNTIME, not just dry-run (R2 M-3 — PLAN-A:120 was wrong).
- Temp-file sweeper handles dead-pid case (R2 H-2).
- 3-site `maxConcurrency` clamp stays in sync via shared constant.

**10. Rollback strategy.** Most thorough test coverage required because PR touches both runners (PLAN-MASTER:135). Multi-commit revert (plan-builder, recursion, atomic-write, clamp, cycle-detection separable). Existing recipes preserved; chained `hasWriteSteps` regresses to `false` (acceptable transient state).

---

## Phase 5 — Resolver unification + remaining HTTP — week 5

### B-PR3 — Lower `kind:prompt` JSON to synthetic YAML (delete `loadRecipePrompt`)

**1. Title + scope.** Replace `loadRecipePrompt` text-builder with `loadJsonPromptAsYamlRecipe` that returns a synthetic single-agent-step `YamlRecipe`. Migrate **3 production callers** (R1 R3 — plan listed only 1).

**2. Bugs closed.** JSON-prompt drift (HIGH — lint/schema/`recordRecipeRun`/VD-2/silent-fail bypass), `daily-status` shadow root cause (HIGH), R2 H-routes Bug 6 (`recordRecipeRun` not called).

**3. Files to touch.**
- `src/recipesHttp.ts:995-1047` — DELETE `loadRecipePrompt`. Replace with `loadJsonPromptAsYamlRecipe(recipesDir, name): YamlRecipe | null`.
- `src/recipeOrchestration.ts:344-365` (`runRecipeFn`) — replace `loadRecipePrompt` branch.
- `src/recipeOrchestration.ts:306` (webhook handler) — replace `loadRecipePrompt` call (R1 R3 — missed in plan).
- `src/recipes/scheduler.ts:327` (cron scheduler) — replace `loadRecipePrompt` call (R1 R3 — missed in plan).
- `src/recipesHttp.ts:1054-1068` (`renderWebhookPrompt`) — verify webhook payload interpolation still works post-lowering.
- `src/__tests__/jsonPromptLowering.test.ts:NEW`
- `src/__tests__/jsonPromptWebhook.test.ts:NEW` (R1 R3)
- `src/__tests__/jsonPromptScheduler.test.ts:NEW` (R1 R3)

**4. Approach.** At load time, JSON `kind:prompt` synthesizes YamlRecipe with one agent step. Lint, schema, `recordRecipeRun`, VD-2, silent-fail apply for free **provided B-PR1a has landed** (R3 §7 — "for free" understates dep). All 3 callers migrate uniformly.

**5. Regression tests required.**
- T8 (recordRecipeRun): `daily-status.json` fired via `runRecipeFn` → `recordRecipeRun` invoked exactly once. Closes R2 H Bug 6.
- T9 (lint applies): malformed JSON test recipe (no `name`) → lint surfaces it.
- T10 (greet.json end-to-end): output identical to current behavior.
- T22 (webhook): JSON-prompt webhook recipe → fires through synthesized YAML, payload interpolated.
- T23 (scheduler): JSON-prompt cron recipe → fires through synthesized YAML at cron boundary.
- T24 (taskId format): assert `{ok: true, taskId}` response shape preserved (R1 R4 — taskId format change risk).

Round-2 finding match: H-routes Bug 6 + R1 R3 (3 callers) + R1 R4 (taskId format) + R1 R6 (inflight dedup risk).

**6. Maintainer decisions blocking start.**
- **R1 R4 taskId format change** — preserve orchestrator-task-id surfacing OR document breaking change (`task_abc123` → `daily-status-1777627780016`). Plan B-PR3 didn't address. Pick before merge.
- **R1 R6 inflight dedup** — JSON-prompt recipes will gain `RecipeOrchestrator.fire`'s name-based dedup. Users firing back-to-back may get `already_in_flight` errors they never got before. Document.
- **R1 R7 schema/lint after lowering** — JSON `kind:prompt` files still fail YAML schema. Lint/schema check the LOWERED YAML, not raw JSON? Document or fix.

**7. Cross-bundle dependencies.** **Depends on B-PR1a** (synthesized YAML inherits silent-fail + VD-2 only if B-PR1a landed first). Independent of B-PR1b. Independent of B-PR4 — but B-PR4 ideally lands after to clean up resolver layer (R3 §3.5 dep-graph honest version).

**8. Estimated diff size.** ~250 LoC source / ~300 LoC tests across 6 files. (R1 R3: plan undercounted callers; 3-caller migration adds ~80 LoC.)

**9. Reviewer focus areas.**
- All 3 callers migrated (R1 R3 — webhook + scheduler + runRecipeFn).
- taskId response shape preserved or breaking change documented (R1 R4).
- `RecipeOrchestrator.fire` dedup behavior change documented (R1 R6).
- Schema/lint posture for raw JSON files clarified (R1 R7).
- Activation metrics now bumped for JSON-prompt — release note (R1 §Q3 #4).

**10. Rollback strategy.** Single PR; revert restores 3-runner architecture with `loadRecipePrompt`. New `loadJsonPromptAsYamlRecipe` deletable. Run records emitted post-B3 carry `stepResults` (different from pre-B3 `stepResults: []`); revert leaves new records with single step in run log — graceful.

---

### B-PR4+C-PR4 (combined) — Canonical resolver + PATCH ESM + 4 nested HTTP routes

**1. Title + scope.** New `src/recipes/resolveRecipe.ts` as single canonical resolver (YAML-wins on collision); fix PATCH `/recipes/:name` ESM `require` bug; add 4 missing nested HTTP routes (`/runs`, `/permissions` GET+POST, `/activation-metrics`); explicit-extension URL form per R1 §Q4 + R3 DP-6.

**2. Bugs closed.** #14 (HIGH — `daily-status` two-layer disagreement), R2 H-routes new CRITICAL (PATCH ESM `require is not defined`), #15 subset (HIGH — 4 of 6 nested routes).

**3. Files to touch.**
- `src/recipes/resolveRecipe.ts:NEW` — `resolveRecipe(recipesDir, name): { kind: "yaml"|"json-prompt", path, parsed } | null`. **YAML wins** + warning on collision.
- `src/recipesHttp.ts:200` — replace `require("./patchworkConfig.js")` with top-level `import { savePatchworkConfig }`.
- `src/recipesHttp.ts:458-490` (`loadRecipeContent`) — call `resolveRecipe`.
- `src/recipeOrchestration.ts:344-388` — call `resolveRecipe`.
- `src/recipes/scheduler.ts:286-340` — call `resolveRecipe` (R1 §Q4 — missed in plan).
- `src/recipeOrchestration.ts:297-318` (webhook) — `match.filePath`-based path; document non-resolveRecipe path (R1 §Q4 — webhook doesn't fit pattern).
- `src/recipeRoutes.ts` PATCH/DELETE/PUT — align with `resolveRecipe`.
- `src/commands/recipe.ts` (multiple call sites) — align.
- DELETE: `findYamlRecipePath`, `resolveJsonRecipePathByName` (now private to `resolveRecipe.ts`).
- `src/recipeRoutes.ts:NEW routes` — `GET /recipes/:name/runs`, `GET /recipes/:name/permissions`, `POST /recipes/:name/permissions` (drop if A-PR4 Option B per R3 DP-7), `GET /recipes/:name/activation-metrics`.
- `src/recipeRoutes.ts:NEW URL form` — `/recipes/:name.json` and `/recipes/:name.yaml` extension forms (R1 §Q4 + R3 DP-6 — PLAN-B rejected, PLAN-C recommends; pick one — R1 A4 maintainer decision).
- `src/__tests__/resolveRecipe.test.ts:NEW` — collision, YAML-only, JSON-only, neither.
- `src/__tests__/server-recipes-content.test.ts` — extend (PATCH no-injection).
- `src/__tests__/server-recipes-nested-routes.test.ts:NEW`

**4. Approach.** Single resolver, YAML-wins, warning on collision. PATCH ESM is one-line. 4 routes per DP-7 land set.

**5. Regression tests required.**
- T11 (YAML wins collision): both variants installed → resolveRecipe returns YAML.
- T12 (warning emitted once): collision → single `logger.warn` per name.
- T25 (PATCH ESM): `setRecipeEnabled("legacy-name", false)` returns `{ok: true}` without `saveConfigFn:` injection. Bug Fix Protocol: write test FIRST, confirm fails on current source, then fix.
- T26 (URL extension form — IF R1 A4 = PLAN-C): `GET /recipes/daily-status.yaml` returns YAML; `.json` returns JSON.
- T27 (nested route `/runs`): wraps `/runs?recipe=:name`.
- T28 (`/permissions` GET 200/404): with/without sidecar.
- T29 (`/permissions` POST): updates sidecar (or drop if R3 DP-7).
- T30 (`/activation-metrics`): per-recipe block.
- T31 (scheduler resolveRecipe): scheduler picks YAML on collision (R1 §Q4).

Round-2 finding match: round-1 #14 + #15 (4 of 6) + R2 H-routes new-CRITICAL (PATCH ESM) + R2 H-routes Bug 5 (`/recipes/:name/runs`) + R1 §Q4 (scheduler + webhook) + R3 DP-7 (`/permissions` POST inconsistency).

**6. Maintainer decisions blocking start.**
- **R1 A4 (per-extension URL routing)** — PLAN-B rejects, PLAN-C recommends. **PLAN-MASTER must pick one before this PR ships.** Recommend PLAN-C extension form so dashboard JSON-variant-access doesn't break silently.
- **R3 DP-6** — same decision restated. Confirm extension URL form ships alongside YAML-wins.
- **R3 DP-7** — drop `POST /recipes/:name/permissions` if A-PR4 = Option B (no sidecars to update). Recommend drop.
- **DP-6 (`daily-status` precedence)** — confirm YAML-wins. R1 §Q4 notes user has BOTH variants; current JSON variant is the active one. This is a breaking change for the user firing the audit. Migration: warning + extension-URL fallback.

**7. Cross-bundle dependencies.** Independent of B-PR1a/B-PR1b for correctness. Better tested post-B-PR3 (R3 §3.5). Depends on **A-PR4 decision** (R3 DP-7 inconsistency).

**8. Estimated diff size.** ~300 LoC source / ~280 LoC tests across 8 files. (Plan estimates 250 — undercounted scheduler + webhook + extension URL + collision tests.)

**9. Reviewer focus areas.**
- Per-extension URL form decision honored consistently (R1 A4).
- Scheduler + webhook callers migrated (R1 §Q4 — plan listed only 4 of 7+ paths).
- Bug Fix Protocol: PATCH ESM test FAILS on current source before fix.
- `POST /recipes/:name/permissions` posture matches A-PR4 decision (R3 DP-7).
- Collision warning fires at startup AND on `loadRecipeContent` (R1 §Q4 — rate-limited per name).

**10. Rollback strategy.** PATCH ESM revert restores `require` bug. resolveRecipe rollback restores 7-resolver-site drift. **Risky for `daily-status` user**: revert restores JSON-first dispatch but YAML-fired runs in interim now have data the user didn't expect. Coordinate with user before revert.

---

## Phase 6 — Trigger wiring + repo hygiene — week 6

### C-PR3 — Trigger wiring + scheduler hardening + nested-recipe gaps

**1. Title + scope.** Wire YAML-declared `on_file_save`/`on_test_run`/`on_recipe_save`/`git_hook` triggers via `compileRecipe` → `AutomationProgram` scaffolding; fix scheduler `timezone`; fix `nestedRecipeStep` off-by-one; add cron post-startup install hook; runtime cycle detection on inter-recipe calls; reject duplicate `name:` collisions; multi-yaml package registration; nested child runs visible in `/runs`.

**2. Bugs closed.** #3 (HIGH — schema/parser/validator disagree), #6 (HIGH — YAML triggers never auto-fire), #10 (MED — cron local TZ), #13 (MED — `nestedRecipeStep` off-by-one), #28 (LOW — starter-pack `event:`), I-e2e #3 (CRITICAL — inter-recipe cycle detection — R3 amendment 2), I-e2e #4 (HIGH — cron post-startup install — R3 amendment 2), I-e2e #5 (HIGH — duplicate `name:` — R3 amendment 2), I-e2e #6 (HIGH — multi-yaml drop — R3 amendment 2), I-e2e #9 (HIGH — nested child runs absent from `/runs` — R3 amendment 2).

**3. Files to touch.**
- `src/recipes/scheduler.ts:178, 193, 232` — broaden trigger pickup, add `timezone: tz` option (`parsed.trigger.timezone ?? cfg.recipes?.timezone ?? "UTC"`).
- `src/recipes/scheduler.ts:NEW reload()` — hot-reload method called from `installer.ts` post-install (R3 amendment 2 — I-e2e #4).
- `src/recipes/validation.ts:57-66` — trigger-type allowlist canonical.
- `src/recipes/validation.ts:73-78` — add `trigger.timezone` field.
- `src/recipes/compiler.ts:154-180` (`mapTrigger`) — exhaustive switch: `manual`, `cron`, `webhook`, `file_watch`, `git_hook`, `on_file_save`, `on_test_run`, `on_recipe_save`, `chained` (throw — chained isn't a hook).
- `src/automation.ts:540, 981, 1537, 1601` — `_enqueueRun` + per-recipe hook synthesizer.
- `src/recipes/nestedRecipeStep.ts:70` — `>` → `>=`. Update message.
- `src/recipes/installer.ts:65-77` — emit AutomationProgram from `compileRecipe`, register with running interpreter. Call `scheduler.reload()` post-install if recipe has cron trigger (R3 amendment 2).
- `src/recipes/NEW RecipeAutomationRegistry.ts` — walks `~/.patchwork/recipes/*.{yaml,yml,json}` at boot, pulls non-`{cron,webhook,manual,chained}` triggers, calls `compileRecipe`, registers with `automationInterpreter`. Dedup by recipe-name. Hot-reload on `onRecipeSave`.
- `src/recipes/installer.ts:NEW uniqueness check` — reject second recipe with already-registered `name:` (R3 amendment 2 — I-e2e #5).
- `src/recipes/installer.ts:NEW multi-yaml walk` — register every YAML in install dir, not one (R3 amendment 2 — I-e2e #6).
- `src/recipes/loadNestedRecipe.ts:NEW name-stack tracker` — thread `Set<string>` of nested recipe names; reject re-entry (R3 amendment 2 — I-e2e #3 — PLAN-A:120 misclaimed cycle detection existed).
- `src/recipes/chainedRunner.ts:420-426` — emit child `RecipeRun` for nested calls (depth>0 path) so `/runs` includes them (R3 amendment 2 — I-e2e #9).
- `examples/recipes/_vision-tier/` — move 7 starter-pack recipes with `event:` triggers (R3 amendment 2 — #28).
- `src/recipes/__tests__/scheduler.timezone.test.ts:NEW`
- `src/recipes/__tests__/scheduler.reload.test.ts:NEW` (R3 amendment 2)
- `src/recipes/__tests__/nestedRecipeStep.test.ts` — extend with `>=` test.
- `src/recipes/__tests__/compiler.triggerCoverage.test.ts:NEW`
- `src/__tests__/recipeAutomationRegistry.test.ts:NEW`
- `src/recipes/__tests__/installer.compile.test.ts:NEW`
- `src/recipes/__tests__/installer.uniqueness.test.ts:NEW` (R3 amendment 2)
- `src/recipes/__tests__/installer.multiYaml.test.ts:NEW` (R3 amendment 2)
- `src/recipes/__tests__/loadNestedRecipe.cycleDetection.test.ts:NEW` (R3 amendment 2)
- `src/recipes/__tests__/nestedChildRuns.test.ts:NEW` (R3 amendment 2)

**4. Approach.** Largest PR scope-wise. Per R3 amendment 2, this PR pins I-e2e seams #3/#4/#5/#6/#9 — currently CLAIMED by PLAN-MASTER but UNPINNED in PLAN-C. Without pinning, those seams resurface in next dogfood cycle.

**5. Regression tests required.**
- T32 (scheduler timezone): mock `cron.schedule`, assert `timezone` option passed; default UTC; per-recipe override.
- T33 (`>=` regression): `validateNestedRecipe({recipeMaxDepth: 2, currentDepth: 2})` → `valid: false`.
- T34 (compiler trigger coverage): every type in `validation.ts:57-66` compiles or returns documented no-op; `chained` throws.
- T35 (registry on_file_save): fire fake event, recipe with matching glob enqueues; non-matching does not.
- T36 (installer compile): install with `git_hook` trigger; AutomationProgram registered.
- T37 (cron post-startup): install recipe with cron trigger after bridge running; recipe fires at next cron boundary (R3 amendment 2 — I-e2e #4).
- T38 (duplicate name uniqueness): install second recipe with same `name:` → error, not silent. (R3 amendment 2 — I-e2e #5).
- T39 (multi-yaml package): install dir with 3 YAMLs → all 3 registered (R3 amendment 2 — I-e2e #6).
- T40 (inter-recipe cycle): recipe A names B, B names A → load-time rejection (R3 amendment 2 — I-e2e #3).
- T41 (nested child runs): nested recipe call → child appears in `/runs` (R3 amendment 2 — I-e2e #9).
- T42 (event:` triggers): recipes with `event:` in `_vision-tier/` not registered as auto-firing.

Round-2 finding match: round-1 #3 + #6 + #10 + #13 + #28 + I-e2e #3/#4/#5/#6/#9 (R3 amendment 2 — currently unpinned in PLAN-C).

**6. Maintainer decisions blocking start.**
- **DP-4 (trigger wiring Option A)** — confirm. R3 DP-4: realistic estimate is ~1 senior week, NOT 3-4 days. Risk: re-fire storms on file-watch hot-reload, race between scheduler and registry on cron triggers. Should be flagged HIGH risk in PR description.
- **R3 amendment 2 (5 I-e2e seams)** — confirm scope expansion to pin I-e2e #3/#4/#5/#6/#9 in PLAN-C. Without expansion, paper coverage gap remains.
- **#28 starter-pack disposition** — drop `event:` triggers (Option 1) vs wire generic event source (Option 2). Plan recommends Option 1.

**7. Cross-bundle dependencies.** **Depends on C-PR1** (deleted `parser.ts` — validator becomes canonical). **Convenience-depends on B-PR1a** (silent-fail floor — newly-firing triggers misbehave less). Could land Phase 3 or 4 if maintainer accepts R1 §Q5 + R3 §3.4 (silent-fail dep is convenience, not correctness).

**8. Estimated diff size.** ~500 LoC source / ~600 LoC tests across 14 files. (Plan estimates 200/180; R3 amendment 2 expands by ~5 seams, each ~50 LoC source + 60 LoC tests.)

**9. Reviewer focus areas.**
- HIGH risk per R3: re-fire storms + scheduler/registry race.
- All 5 I-e2e seams pinned (R3 amendment 2 — currently un-anchored).
- `RecipeAutomationRegistry` cleanup on hot-reload (no leaked listeners).
- Cooldown defaults from CLAUDE.md (`min 5000`) honored.
- UTC default is breaking change vs current local-TZ — release note.

**10. Rollback strategy.** Multi-commit revert (split per seam if possible). Risk: newly-live triggers fire too aggressively post-merge → revert same day. Pre-merge load test recommended.

---

### A-PR5 — Security regression fixtures

**1. Title + scope.** Promote 6 exploit YAMLs from `/tmp/dogfood-G2/` to repo so PR-1/2/3/4 regression tests survive `/tmp` cleanup; add README warning.

**2. Bugs closed.** None — operational hygiene.

**3. Files to touch.**
- `docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures/:NEW dir` — copy 6 exploit YAMLs.
- `docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures/README.md:NEW` — warning: deliberately malicious; do NOT install into `~/.patchwork/recipes/`; test fixtures only.
- `docs/dogfood/recipe-dogfood-2026-05-01/G-security.md` — update Live Exploit Cleanup section to point at repo paths.
- `.gitignore` — verify `/tmp` excluded (already should be).

**4. Approach.** Pure docs/fixture move. Build/CI must NOT parse these as live recipes — verify they live under `docs/`, not `templates/recipes/`.

**5. Regression tests required.** None directly — A-PR1/A-PR2/A-PR3 tests reference these paths post-promotion.

**6. Maintainer decisions blocking start.** None.

**7. Cross-bundle dependencies.** Last in series. Depends on A-PR1, A-PR2, A-PR3+B-PR2 having merged.

**8. Estimated diff size.** ~0 LoC source / ~0 LoC tests + 6 YAML files + 1 README.

**9. Reviewer focus areas.**
- YAML files clearly marked as malicious in README.
- Not under `templates/recipes/` (build wouldn't load them).

**10. Rollback strategy.** Single revert; deletes fixtures. PR-1/2/3 tests fail at next /tmp cleanup. Acceptable degradation.

---

## Implementation order

### Phase 1 — week 1 (parallel)
- **A-PR1** — `resolveRecipePath` jail + file.* + `vars` validation
- **A-PR2** — `loadNestedRecipe` jail + install allowlist + body cap
- **A-PR4** — Permissions sidecar deletion (PROMOTED — R3 amendment 1)

### Phase 2 — week 2 (sequential within phase)
- **B-PR1a** — Post-step pipeline, no shape change
- **B-PR1b** — `registrySnapshot` delta + runlog v2 + dashboard reader (after B-PR1a; ships atomic with dashboard)

### Phase 3 — week 3 (parallel; C-PR6 schema cap one PR ahead of A-PR3)
- **C-PR1** — Lint whitelist + delete `parser.ts`
- **C-PR2a** — `recipe list` + `recipe run` enumeration parity
- **C-PR2b** — `recipe new` template + dash-prefix + help text
- **C-PR2c** — Dedup warnings + install preflight + dry-run exit code
- **C-PR5** — CamelCase auto-emit + Jira/Sentry tests
- **C-PR6** — Schema cap + replayRun CLI + quick-task try/catch

### Phase 4 — week 4
- **A-PR3+B-PR2 (combined)** — Chained `tool` field + atomic write + maxConcurrency + maxDepth + cycle detection. Depends on A-PR1, C-PR6 constant.

### Phase 5 — week 5
- **B-PR3** — Lower JSON-prompt to YAML (3 callers per R1 R3). Depends on B-PR1a.
- **B-PR4+C-PR4 (combined)** — Canonical resolver + PATCH ESM + 4 nested routes. Coupled to A-PR4 decision (R3 DP-7).

### Phase 6 — week 6
- **C-PR3** — Trigger wiring + scheduler hardening + nested-recipe gaps (5 I-e2e seams per R3 amendment 2). Depends on C-PR1.
- **A-PR5** — Security regression fixtures. Last.

**Parallelization opportunity per R1 §Q5 + R3 §3.4**: A-PR3+B-PR2 could move from Phase 4 to Phase 3b. C-PR3 could move to Phase 4 if maintainer accepts B-PR1a as convenience-only dep. Saves 1-2 weeks if accepted.

---

## Cross-PR test fixture sharing

| Fixture origin | Reused by |
|---|---|
| A-PR5 security-fixtures (`/tmp/dogfood-G2/exploit-traversal.yaml`, `exploit-symlink.yaml`, `exploit-template-traversal.yaml`, `outer-chained.yaml`, `outer-chained-absolute.yaml`, `null-byte-path.yaml`) | A-PR1 (jail tests), A-PR2 (loadNestedRecipe tests), A-PR3 (cycle detection tests), B-PR1a indirectly (regression). Promotion to repo MUST happen before `/tmp` cleanup or tests break. |
| `synthetic-readonly.yaml` (`/tmp/dogfood-F2/`) | A-PR1 regression gate (must keep passing — `/tmp` is default jail root for tests; per R2 C-2 amendment, migrate to `~/.patchwork/test-sandbox/`). |
| `branch-health.yaml` snapshot | C-PR1 lint parity test (0 errors after fix), B-PR1a chained silent-fail (`branch-health`-clone with mock executeTool), A-PR3+B-PR2 chained writes test. |
| `triage-brief.yaml` snapshot | C-PR1 lint parity test (0 errors after fix). |
| `daily-status.yaml` + `daily-status.json` | B-PR3 (JSON-prompt lowering), B-PR4+C-PR4 (collision resolver), C-PR4 (extension-URL form). User has BOTH variants installed — tests must mock or use isolated dir. |
| `morning-brief`-clone | B-PR1a yaml-VD-2 test, R1 §Q1b silent-fail registry-write ordering. |
| `chained-recipe-write.yaml` (NEW in A-PR3) | A-PR3+B-PR2 hasWriteSteps recursion, C-PR3 nested child runs visible. |
| `chained-recipe-readonly.yaml` (NEW in A-PR3) | A-PR3+B-PR2 negative case. |
| `cycle-protection.test.ts` recipe pair (A→B, B→A) | A-PR3+B-PR2 dry-run cycle, C-PR3 inter-recipe cycle (R3 amendment 2 — I-e2e #3). |
| `permissions-deny.yaml` + sidecar (A-PR4 Option A only — superseded) | None if Option B ships. |

**Recommendation**: ship the security-fixtures dir promotion in **Phase 1** alongside A-PR1/A-PR2 instead of waiting until Phase 6. Otherwise `/tmp` cleanup mid-rollout will break already-merged Phase 1 tests. Suggested amendment to V2 list: move A-PR5 to Phase 1 (or split: fixture promotion in Phase 1, README + cleanup-section update in Phase 6).

---

## Decision-deadline calendar

Hard deadlines for maintainer decisions to keep schedule. Each decision blocks specific PR kickoff.

| Week (must answer by end of) | Decision | Blocks | Source |
|---|---|---|---|
| **Week 0** (pre-Phase 1) | DP-1: F-03 permissions Option A vs B vs C | A-PR4 | PLAN-A DP-1 + R3 DP-1 (Option C added) |
| **Week 0** | DP-2: F-05 install allowlist strict vs env-var | A-PR2 | PLAN-A DP-2 + R3 DP-2 SSRF order |
| **Week 0** | R2 C-2: `/tmp` jail roots default off | A-PR1 | R2 C-2 |
| **Week 0** | R2 M-5: bundled-templates path concrete resolution | A-PR2 | R2 M-5 |
| **Week 1** (during Phase 1) | DP-3: maxConcurrency cap value (8/16/32) | C-PR6, A-PR3+B-PR2 | PLAN-A DP-3 + R3 DP-3 sub-issue |
| **Week 1** | R2 H-3: fileLock recommendation strike vs replace with cross-process lock | A-PR3+B-PR2 | R2 H-3 |
| **Week 1** | R3 amendment 5: F-tools F6/F7/F8 in B-PR1a scope or follow-up PR-D | B-PR1a | R3 amendment 5 |
| **Week 1** | R1 A2: `observeStep` ordering before `registry.set` | B-PR1a | R1 A2 |
| **Week 2** | DP-5 + R3 sub-issue: lint whitelist 5-root vs 4-root (drop `$result` if unused) | C-PR1 | DP-5 + R3 DP-5 |
| **Week 2** | DP-9: `parser.ts` delete | C-PR1 | DP-9 |
| **Week 2** | DP-4: camelCase auto-emit strategy | C-PR5 | DP-4 + R3 DP-8 |
| **Week 3** | R1 R4: B-PR3 taskId format change preserve vs document break | B-PR3 | R1 R4 |
| **Week 3** | R1 R6: B-PR3 inflight dedup behavior change documented | B-PR3 | R1 R6 |
| **Week 3** | R1 R7: B-PR3 schema/lint posture for raw JSON files | B-PR3 | R1 R7 |
| **Week 4** | R1 A4: per-extension URL routing (PLAN-B reject vs PLAN-C recommend) | B-PR4+C-PR4 | R1 A4 + R3 DP-6 |
| **Week 4** | R3 DP-7: drop `POST /recipes/:name/permissions` if A-PR4 Option B | B-PR4+C-PR4 | R3 DP-7 |
| **Week 4** | DP-6: `daily-status` YAML-wins precedence + extension-URL fallback | B-PR4+C-PR4 | DP-6 + R1 §Q4 |
| **Week 5** | R3 amendment 2: confirm I-e2e #3/#4/#5/#6/#9 pinned in C-PR3 scope | C-PR3 | R3 amendment 2 |
| **Week 5** | DP-4 trigger wiring Option A confirmed (R3: realistic 1-week, not 3-4 days) | C-PR3 | DP-4 + R3 DP-4 |
| **Week 5** | #28 starter-pack: drop event-triggers vs wire event source | C-PR3 | PLAN-C #28 |

**Critical path of decisions**: DP-1 (Week 0), R1 A2 (Week 1), R1 A4 (Week 4), R3 amendment 2 (Week 5). Missing any of these slips the corresponding PR by ≥1 week.

**Decisions that cluster**: A-PR4 (DP-1), B-PR4+C-PR4 (R1 A4 + R3 DP-7 + DP-6), C-PR3 (R3 amendment 2 + DP-4 + #28). Recommend a single weekly maintainer-decision review meeting capturing all decisions for that week's kickoff.
