# REVIEW-4 — Independent pre-ship sign-off

**Subject**: Should Phase 1 of `PLAN-MASTER.md` start, given the amendments raised by REVIEW-1, REVIEW-2, REVIEW-3?
**Method**: read-only audit of the master plan + the three reviews + dogfood reports A–K. Treat the plan as if I have never seen rounds 1–2 and never wrote any review. Cite every claim.
**Verdict**: see §1.

---

## 1. Verdict

**SIGN-OFF-WITH-CONDITIONS** — do **NOT** start Phase 1 until the **9 blocking conditions** in §2 are met. None of them require new architectural work; all are 1-line plan amendments, decision-doc resolutions, or pinning of unowned scope into a named PR. Most can be cleared in 1 sitting. The plan is *substantively* sound, but PLAN-MASTER's three biggest "fold into Phase 6" claims are paper-coverage gaps with no PLAN-C anchor (R3-§1.5; "I-e2e Seam #3 not addressed" R3:163; PLAN-A:120 cycle-detection misclaim R3:474), and Phase 1 as currently scoped does not actually stop the bleed (R3-§3.1 — F-03 lives in Phase 2).

I am not signing off blank because:

1. PLAN-MASTER claims to cover I-e2e seams #3, #4, #5, #6, #9 via C-PR3 (PLAN-MASTER:112), but C-PR3's pinned scope in PLAN-C-schema-cli.md:269-358 contains none of them (R3:128-145, R3:484). This is a paper coverage gap that **will resurface as "already-known-but-not-actually-fixed" in the next dogfood cycle.**
2. PLAN-A:120 explicitly says inter-recipe cycle detection "already exists at chainedRunner.ts:993-1009" — R3:474 verified that cite covers **intra-recipe DAG cycles only**, not inter-recipe call cycles. The plan rests on a wrong claim. R2 H-1 reaches the same conclusion independently (R2:78-89).
3. R2 C-1 (chained-runner template substitution as 3rd jail point) and R2 C-3 (vars validation rule says "no control chars" but `..` is not a control char) describe **post-mitigation bypasses of PR-1's intended mitigation**. PR-1 cannot ship without those amendments or the security headline ("traversal exploits blocked") is materially false.
4. R1 R2 (`registryDelta` semantics change without dashboard-side change) — PLAN-MASTER:132 references a "version-branched dashboard reader" that **does not exist in the codebase** (R1:131). B-PR1 would ship a runlog format change with no compatible reader.

---

## 2. Conditions to clear before Phase 1 starts

Each condition is one actionable sentence. Format: who decides → what they decide → what gets pinned where.

### C-1 (BLOCK) — Maintainer must explicitly merge the 9 decisions in PLAN-MASTER §"Maintainer decisions" into a single decision doc, with a written answer for each, before any PR opens.

The 9 decisions (PLAN-MASTER:115-127) are listed but unresolved. R3:172-271 challenges 4 of the 9 with concrete failure scenarios. Without resolved answers, A-PR4 (depends on DP-1), A-PR2 (depends on DP-2), A-PR3 (depends on DP-3), C-PR3 (depends on DP-4), C-PR1 (depends on DP-5 — verify `$result` is a real runtime root, R3:230-232), B-PR4+C-PR4 (depends on DP-6 + the PLAN-B vs PLAN-C extension-URL contradiction R1 R5/R1:480-485), C-PR4 (depends on DP-7), C-PR5 (DP-8), C-PR1 (DP-9) — all have a hidden block.

### C-2 (BLOCK) — Resolve the PLAN-B vs PLAN-C contradiction on per-extension URL routing for daily-status (R1 R5).

PLAN-B-runners.md:280 explicitly **rejects** per-extension URLs ("breaks the existing API contract"). PLAN-C-schema-cli.md:431-448 explicitly **recommends** them. PLAN-MASTER:56 silently combines the two PRs. R1:485 and R3:236-244 both flag this. Pick one, pin in PLAN-MASTER, before B-PR4+C-PR4 opens. R3-DP-6 also notes the dashboard's "Run JSON variant" button breaks silently if URL form isn't shipped.

### C-3 (BLOCK) — Promote A-PR4 (permissions-sidecar decision) from Phase 2 to Phase 1.

R3:282-286 + R3:488 — A-PR4 is independent of A-PR1/A-PR2 and is ~50 LOC if Option B. F-03 (permissions theatre) is CRITICAL per G-security.md:80-96. Phase 1's headline "live-PoC traversal exploits blocked. SSRF closed. Recipe-runner is no longer a sandbox-escape primitive" (PLAN-MASTER:25) is **false** until F-03 is closed. Promote A-PR4 to Phase 1 OR change the Phase 1 outcome statement to honestly say "F-03 still active."

### C-4 (BLOCK) — Pin I-e2e seams #3, #4, #5, #6, #9 to actual files in named PRs (or remove them from the coverage table).

PLAN-MASTER:95-113 and PLAN-MASTER:111-112 claim C-PR3 covers them. PLAN-C C-PR3 actual scope (PLAN-C-schema-cli.md:269-358) does not. Per R3:484 and R3:489-495:

- Seam #3 (inter-recipe cycle detection) → name-stack tracker in `loadNestedRecipe` or `chainedRunner.ts:420`. Do **not** rely on PLAN-A:120's `chainedRunner.ts:993-1009` cite — that's intra-recipe DAG. R2 H-1 + M-3 reach the same conclusion.
- Seam #4 (cron post-startup install never fires) → `RecipeScheduler.reload()` method called from `installer.ts` or via file-watcher. Confirm scheduler has no `reload()` today via grep first.
- Seam #5 (duplicate `name:` conflict makes both unreachable) → install-time uniqueness check OR runtime conflict-error. B-PR4's resolver only handles JSON-vs-YAML, not YAML-vs-YAML (R1:565).
- Seam #6 (multi-yaml package drops recipes silently) → `installRecipeFromFile` registers every YAML in dir, not just one. Confirmed not the same as C-PR2's `recipe list` widening (R1:362).
- Seam #9 (nested child runs absent from `/runs`) → `recordRecipeRun()` for nested calls OR documented limitation.

### C-5 (BLOCK) — Amend A-PR1 to add chained-runner `resolveStepTemplates` → `executeTool` as a **third** jail point (R2 C-1).

`src/recipes/chainedRunner.ts:194-205` substitutes templates into `path:` (which is not in STEP_META_KEYS, R2:24) before dispatching to `executeTool` at `:456`. PR-1 currently jails at file.ts + yamlRunner.ts:976-994 + yamlRunner.ts:642 — the chained path has no equivalent re-validation. Either jail at chainedRunner.ts:456 or at the `buildChainedDeps.executeTool` wrapper in yamlRunner.ts:1252. Without this, F-02 is closed for yaml chained recipes by accident-of-tool-layer-jail; a future regression weakening the file.ts check (e.g. the planned `agent` step using `deps.writeFile` directly, called out in PLAN-A's own PR-1 rationale at PLAN-A:42) re-opens the bypass on the chained path.

### C-6 (BLOCK) — Amend A-PR1's `vars` validation rule from "no control chars, ≤ 1 KB" to a deny-list that actually blocks `..`, `/`, `\\`, `~`, `\0` (R2 C-3 + R2 I-3).

PLAN-A:36 specifies "no control chars, ≤ 1 KB". `..` is not a control char. R2:55-69 demonstrates `vars: {target: "../../../etc/passwd-overwrite"}` passes the rule and the F-02 exploit reproduces post-mitigation. The intent (PLAN-A:42) is correct prose; the rule is wrong. Tests will be written against the rule. Replace with: values are strings (R2 I-3 type-strict), ≤ 1 KB, MUST NOT contain `\0`, ASCII control chars (0x00-0x1F, 0x7F), `..`, unencoded path separators when used in `path:` fields, OR ship the simpler `/^[\w\-. :+@,]+$/u` whitelist. The post-render jail is the only **actual** defence; the false-confidence wording on line 42 must be removed or aligned.

### C-7 (BLOCK) — Amend A-PR1 default jail roots to drop `/tmp` (R2 C-2).

PLAN-A:42 + PLAN-A:254 default jail roots to `~/.patchwork`, `os.tmpdir()`, `opts.workspace`. Multi-tenant deployment (Pro relay, hosted bridge, per CLAUDE.md "Remote Deployment") makes `/tmp` cross-tenant on Linux. Make `/tmp` opt-in via env var (`CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1`) or NODE_ENV-gated. Migrate `synthetic-readonly.yaml` (writes to `/tmp/dogfood-F2/`) to `~/.patchwork/test-sandbox/`.

### C-8 (BLOCK) — Split B-PR1 into B-PR1a (post-step pipeline) + B-PR1b (registrySnapshot delta + runlogVersion: 2 + dashboard reader). (R1 A1 + R3-§4.2 + R3:497.)

B-PR1 as planned is ~1,000 LOC across 8 files (R3:377) including a dashboard-side change to `dashboard/src/lib/registryDiff.ts:142-168` that **PLAN-MASTER:132's "version-branched dashboard reader" implies but does not actually exist** (R1:131). Splitting:

- B-PR1a — extract `stepObservation.ts`, wire silent-fail + VD-2 into both runners, **keep `registrySnapshot` as full snapshot** (no shape change). ~500 LoC.
- B-PR1b — convert to delta + add run-level final snapshot + add `runlogVersion: 2` field + dashboard branch reader. ~350 LoC bridge + ~80 LoC dashboard.

Without the split, the silent-fail floor (the actual safety fix) is coupled to a dashboard-format change.

### C-9 (BLOCK) — Add `runlogVersion: 2` rollout plan to PLAN-MASTER explicitly.

The plan's rollback story (PLAN-MASTER:132) hand-waves "old rows continue to work via the version-branched dashboard reader" — that reader does not exist (R1:131). Three things must be pinned:

1. Field is additive on disk (verify in `runLog.ts:34-53` change spec).
2. Dashboard reads both v1 and v2 (write the reader as part of B-PR1b per C-8).
3. `ctxQueryTraces` body field exposes the new shape to LLM consumers (R1:139-149) — either documented or masked.

This is not a feature-flag rollout — there is no proposed gate (no env-var, no setting). New rows from the moment B-PR1b ships will be v2; old rows stay v1. That's fine, but the plan must say it.

---

## 3. Contradiction matrix between R1 / R2 / R3

| # | Topic | R1 says | R2 says | R3 says | Winner | Why |
|---|---|---|---|---|---|---|
| X1 | Inter-recipe cycle detection | "missing" (R1:359 GAP) + recommends B5 add tracker (R1:596-600) | "missing" — `runChainedRecipe` recursion uncapped beyond `maxDepth`; PR-3 must clamp + add stack tracker (R2:78-89, M-3 R2:160-169) | "missing"; Plan-A:120 claim is **materially wrong** because cite covers intra-recipe DAG only (R3:130, R3:474) | **R3** | R3 has the source-pinned cite and disambiguates *why* PLAN-A's reuse claim is wrong; R1 + R2 reach the same fix but R3 catches PLAN-A's hidden mis-claim. All three agree on the gap; R3's pin is the strongest. |
| X2 | Phase 4 dependency on Phase 2 | "Phase 4 is independent of B-PR1; could ship Phase 3" (R1 §Q5, R1:316-345, R1 R8, A C1) | (silent — security focus, doesn't address phase ordering) | "load-bearing claim is overstated; B-PR1 is load-bearing only for B-PR3" (R3:288-298) | **R1 + R3 agree** | Two reviews independently reach the same conclusion. PLAN-MASTER:71-93 dep graph is overstated. Master should flatten Phase 4 into Phase 3b. |
| X3 | F-03 sidecar-deletion (DP-1 Option B) | (silent — out of scope) | "consistent with audit, deletion is safe" (R2 positive findings :280) | "Option B is the weakest 'do less' recommendation; proposes Option C — delete sidecar AND add a 30-line enforcement layer" (R3:177-190) | **Maintainer must decide** — neither review is wrong. R2 confirms the readers are only boolean-existence checks (safe to remove). R3's concern is operator UX (dashboard surfaces a "no permissions ever" badge that today exists). Both are valid. Pick one in C-1. |
| X4 | F-09 maxConcurrency = 16 | (silent) | "16 is fine; tradeoff stated correctly" (R2 L-1 :194-200) | "16 is per-recipe, not bridge-wide; need bridge-wide cap" (R3:202-211) | **R3** | R2 acknowledges per-recipe scope; R3 expands to oversubscription failure scenario (4 webhooks × 16 = 64). Both correct; R3 is stricter. Add bridge-wide note to PR-3 description. |
| X5 | Atomic-write `fileLock` strong-guarantee | (silent) | "fileLock is in-process only, does NOT serialize across bridge subprocess + concurrent CLI; strike from DP-3 OR replace with cross-process lock" (R2 H-3 :108-123) | (silent) | **R2** | Single-source finding; R2 has the source pin (`src/fileLock.ts:14`). Strike from DP-3. |
| X6 | `registrySnapshot` delta vs dashboard reader | "dashboard reader does NOT exist in codebase today; PLAN-MASTER:132's 'version-branched dashboard reader' is invented" (R1 R2 + Q2) | (silent — security focus) | "B-PR1 size + dashboard reader compat under-budgeted" (R3:528) | **R1 + R3 agree** | R1 has the strongest cite (grep'd `runlogVersion` returns zero hits, R1:131). C-8 + C-9 in §2 above. |
| X7 | `loadRecipePrompt` caller count | "3 production callers, plan addresses 1; webhook + scheduler missed" (R1 §Q3 + R1 R3 + A3) | (silent) | (silent) | **R1** | Single-source finding with source pins; R1:181-189 names `recipeOrchestration.ts:306` (webhook) + `scheduler.ts:327` (cron) — both currently absent from PLAN-B B-PR3's migration list. Pin in B-PR3 before it opens. |
| X8 | F-tools F6 / F7 / F8 silent-fail bypass | "PARTIAL or NOT ADDRESSED" — at least flagged for B-PR1's incidental coverage | (silent — out of plan-A scope, called out in §L-3 :211 as PLAN-B's responsibility) | "5 dropped findings — F6, F7, F8, F10, F11; biggest coverage gap in master plan" (R3:72-78, R3:501) | **R3** | R3 has the most exhaustive enumeration; R1 is partial. Even after B-PR1's `detectSilentFail` wires into chained, three known shapes (linear `{error}`, gmail scalar, yamlRunner JSON-`ok===false` requirement) still slip. Add to B-PR1a scope or open a sibling connector-hygiene PR. |
| X9 | H-routes Bug 3 (unknown-key body validation, `args:` silently dropped) | (silent) | "PLAN-A's `vars` validation does NOT close this; covers vars only, not unknown top-level keys" (R3 audit + I-3) | "tied to HIGH 3 — not addressed beyond `vars`" (R3:122 + R3:499) | **R3** | R3 traces the explicit gap: PLAN-C:13 punts to PLAN-A; PLAN-A doesn't cover unknown-key half. Without an unknown-keys rejector, third-party API consumers continue to silently lose data. Pin in PR-1 or new PR. |
| X10 | C-PR2 size (7 bugs in one PR) | (silent) | (silent) | "C-PR2 is reasonably 3 PRs" (R3:386-396, R3:507) | **R3** | Single-source review-burden finding. Defensible reasoning; not a correctness block. Lower-priority amendment. |
| X11 | A-PR3+B-PR2 combined PR size | "B-PR2 is independent and small" (R1 §Q5) | (silent) | "Combined is the largest PR in Phase 4" (R3:303-307) | **R3** + R1 partial | R3 enumerates 5 files + 4 test files; R1 doesn't disagree but argues for moving combined PR earlier. Both consistent. Land R3's note in PR description. |

**Summary**: R3 is the most-evidence-rich on coverage gaps and PR-size realism. R2 is the strongest on security correctness. R1 is the strongest on architectural sequencing and B-PR1's specific code-level objections. **No two reviews directly contradict each other** — they cover overlapping but mostly complementary surfaces. Where they overlap, they agree.

---

## 4. Vague amendments — list of amendments that need concretization before an implementer could pick them up

Each entry below is something one of the three reviews recommended that an implementer cannot act on without further specification.

### From REVIEW-1

| ID | Vague amendment | What's missing |
|---|---|---|
| V1 | "PLAN-B-runners.md §4 PR B1 should specify `observeStep` ordering w.r.t. `registry.set`" (R1 R1 + A2 :543-549) | What pseudo-code change to chainedRunner.ts:820-855 — does `observeStep` run before `registry.set`? Where does the synthetic post-step snapshot get computed? Plan must include a 5-line `before/after` diff. |
| V2 | "Address taskId format change in B-PR3" (R1 B2 :578) | Decide: surface yamlRunner-emitted `yaml:${name}:${ts}` (and document breaking change) OR preserve orchestrator-id by routing the synthetic agent step through `runAndWait` and returning that taskId. Plan picks neither. |
| V3 | "Address ctxQueryTraces body-shape exposure" (R1 B4 :592) | Mask vs document. If mask: which fields strip? If document: where does the doc go? |
| V4 | "Document fix for I-e2e #9 (nested child runs absent from `/runs`)" (R1 B6 :603) | Either separate `RecipeRunLog` record per nested call (architectural) or post-hoc reconstruction from parent `childOutputs` (cosmetic). Plan offers neither path. |
| V5 | "Resolve open question 4 (bundled-templates path) before PR-2 review" (R2 M-5 :180-188) | Concrete path: `path.resolve(__dirname, '../templates/recipes')` vs `require.resolve` vs npm-global. Plan has 4 candidate locations and zero decisions. |

### From REVIEW-2

| ID | Vague amendment | What's missing |
|---|---|---|
| V6 | "Address F6/F7/F8 silent-fail bypass" (R2 L-3 :211 + R3:501) | Generalize `detectSilentFail` to recognize `{error}` shape OR canonicalize connector error envelopes? Pick one. R3 §5 names the right connector files but doesn't pick the fix. |
| V7 | "Add lint-rule task referring to PLAN-C for child_process/shell-spawn detection" (R2 L-4 :219) | Where in `validation.ts`? Which symbol set triggers? Plan punts to PLAN-C; PLAN-C does not pin it. |
| V8 | "PR-3 must include a startup-time sweeper at bridge boot for `*.tmp.<pid>.*` files" (R2 H-2 :104) | Sweep where? `~/.patchwork/inbox/`, `~/.patchwork/journal/`, `~/.patchwork/runs/`, OR a dedicated `~/.patchwork/.tmp/`? Plan lists "alternative: place tmp files under `~/.patchwork/.tmp/`" without picking. |
| V9 | "Specify deprecation-warning emission point + format for Option B (sidecar)" (R2 L-2 :202) | Once-per-boot vs per-load? Console.warn vs structured log? Plan acknowledges this is under-specified but doesn't fix. |

### From REVIEW-3

| ID | Vague amendment | What's missing |
|---|---|---|
| V10 | "Pin I-e2e Seams #3, #4, #5, #6, #9 to actual files in PLAN-C C-PR3 (or split out a C-PR3b)" (R3:489) | R3 says where each fix lives but does not say which PR. Implementer reads PLAN-C C-PR3, scope doesn't include the seams. Master must edit either C-PR3 or open C-PR3b. |
| V11 | "Promote A-PR4 (permissions decision) to Phase 1" (R3:488) | Implementer must know whether DP-1 = Option B (50 LoC) or Option A (600 LoC). C-1 above blocks this. |
| V12 | "Add F-tools F6/F7/F8 to a connector-hygiene PR" (R3:501) | Same as V6 — pick fix shape (generalize detector vs canonicalize envelope) and assign to PR. |
| V13 | "Add bridge-wide concurrency cap note to A-PR3 description" (R3:208 — DP-3 sub-issue) | Just a description note OR a real semaphore? Plan punts to "follow-up" — but RecipeOrchestrator memory note says orchestrator is the natural home. Pin to follow-up PR or in-scope. |
| V14 | "Drop `POST /recipes/:name/permissions` from C-PR4's land-set if DP-1 = Option B" (R3:509 — DP-7 inconsistency) | Conditional on DP-1; can't be cleared until C-1 is. |
| V15 | "Verify B-PR1's `runlogVersion: 2` round-trip with 3+ tests, not 1" (R3:475) | Test names? Round-trip what? Plan only lists "1 test" (PLAN-B:118). |

**Total: 15 amendments that need concretization.** None individually is a blocker; collectively they are. Easiest path: schedule a 1-hour spec-finalization session with the maintainer + author of each plan, run through V1-V15 sequentially, write decisions into PLAN-MASTER §"Maintainer decisions" + per-PR scope blocks.

---

## 5. Findings the 3 reviews collectively missed

Read the dogfood reports skimming for things flagged by NO review.

### M-1 — No team-velocity reality check on "12 PRs, 6 weeks"

PLAN-MASTER:163 says "12 PRs, 6 weeks, sequential phases. Phases 3-6 contain parallelizable sub-PRs." None of R1, R2, R3 challenges this:

- Recent merge cadence (per memory note `project_2026-04-28_merged_prs.md`): 3 PRs in one day on 2026-04-28.
- This is **one developer** (the user, info@massappealdesigns.co.ke). PLAN-MASTER does not say "single dev sequential" vs "3 devs parallel per phase". With one dev + 2 PRs/day cadence, 12 PRs at conservative 1 PR/day = ~12 working days, not 6 weeks. With 1 PR/2 days (review burden), ~24 working days = 5 weeks.
- **6 weeks is conservative IF single-dev**. R3 implicitly assumes one dev (R3:222 "Realistic estimate: 1 senior week"). Pin the assumption explicitly in PLAN-MASTER.

### M-2 — No `runlogVersion: 2` rollout plan beyond the "additive schema" claim

C-9 in §2 above. None of R1/R2/R3 asks: is there a feature flag? Does the user opt in? What happens if a v2-aware bridge reads a v1 run? What if a v1-aware bridge reads a v2 run? R1 partially flagged the dashboard reader gap (R1:131) and R3 partially flagged the test budget (R3:475) but **no review explicitly demanded a written rollout plan with feature-flag/migration semantics**. Without one, B-PR1b ships and the moment a new run record is written, all downstream readers (dashboard, ctxQueryTraces, replayRun, third-party CLI scripts) see the new shape with zero opt-out.

### M-3 — No migration story for installed recipes that hit breaking changes

R1 + R2 + R3 collectively address the bridge-side compat. None addresses: **what happens to user-installed recipes that today depend on `output:` keyword + `event:` triggers + JSON-prompt taskId + bare `{{name}}` flat-key refs**?

- `output:` keyword emits deprecation warning on every load TODAY (round-1 bug #24). PLAN-C C-PR2's `dedup migration warnings` (PLAN-C-schema-cli.md:198-208) hides the symptom — recipes still emit `output:`, R3:42 acknowledges. **Migration script needed: bulk-rewrite installed recipes from `output:` to canonical alternative.** No review asks for this.
- `event:` triggers move to `_vision-tier` (PLAN-C:344-358). Recipes with `event:` triggers will lint-fail post-C-PR3. **Migration: scan + flag + offer rewrite.** No review asks.
- `kind: prompt` JSON recipes are lowered at load time post-B-PR3. Today's JSON recipes lint/schema-fail (round-1 #16). **Migration: warn-on-load that JSON `kind:prompt` is a load-time-only shape; offer YAML conversion.** Plan acknowledges (PLAN-B:294-303) but no migration script is pinned.

### M-4 — No bridge-build-version-tracking story

The single biggest reason round-2 happened was bug #12 (PLAN-MASTER round-1 list, MEDIUM): "Bridge staleness masks PR #70/#71/#72 fixes." Bridge process started 2026-04-29 11:17, fixes merged 12:27 + 12:56 same day, V8 cached old modules. Confirmed in A-live-runs.md:91. **A fresh build was needed to even surface that bug #70 was fixed.**

None of R1, R2, R3 asks: how do we prevent this re-occurring? Options:

- Add a "bridge-build-version" check to the dashboard that compares `dist/` mtime to running PID start time, surface staleness as a banner.
- Add an `--exit-on-newer-build` flag that auto-restarts the bridge on `dist/` change (similar to `--watch` already in CLI subcommands per CLAUDE.md).
- Add `getBridgeStatus` to report `dist/` mtime and process start time for client-side comparison.

The plan ships 12 PRs. After PR #1, the running bridge will be stale until restarted. **Without a build-version surfacing story, every PR in this plan reproduces bug #12.** Pin to one PR or open a 16th PR.

### M-5 — No CI / infrastructure changes enumerated

PLAN-MASTER:138-145 lists test counts per plan but no CI changes. Implied:

- New audit gate: outputSchema audit (per CLAUDE.md "outputSchema is mandatory") will fail on B-PR1's stepObservation tools if they're not exempt.
- New ratchet for the security-fixtures dir (A-PR5 promotes `/tmp/dogfood-G2/` to repo). Need to be added to vitest include path AND .gitignore exception.
- Coverage gate (75% lines, 70% branches, 75% functions per CLAUDE.md) — does B-PR1's ~1000 LOC clear it? Not estimated by any review.
- `npx biome check --write` on changed files (per CLAUDE.md "Build & Test"). Implicit pre-commit; works fine with current cadence.

R3 §4 partially covers PR-size realism but doesn't audit CI machinery. **Pin: at least one PR in Phase 1 should include a CI gate update if any new fixture dir or audit allowlist is required.** A-PR5 (Phase 6) explicitly is "promote fixtures" — but that's last; security regression tests don't exist in repo for ~5 weeks. R2 implicitly trusts this; flag explicitly.

### M-6 — No coordination with ADR-0001 (dual version numbers) for `runlogVersion: 2`

CLAUDE.md "Version numbers" section: `BRIDGE_PROTOCOL_VERSION` (wire format) vs `PACKAGE_VERSION` (npm). ADR-0001 governs. `runlogVersion: 2` is a third version axis. None of R1/R2/R3 asks: should this go in the same ADR? Should there be ADR-0006? Without coordination, the bridge has 3 unrelated version axes that can drift.

**Recommend**: open ADR-0006 ("Recipe runlog format versions") before B-PR1b ships. One-paragraph ADR. Cheap insurance.

### M-7 — No memory-note update plan post-PR

Per CLAUDE.md "Documentation & memory" — "After architectural changes — update CLAUDE.md so future sessions have accurate context." PLAN-MASTER does not list any CLAUDE.md updates as part of any PR. After B-PR1 lands, CLAUDE.md's Architecture Rules section needs updating (`extensionClient` shape validation block has 8 latent shape-mismatch bugs — `stepObservation` adds another shape contract). After B-PR3 lands, the "third runner" reference in dogfood reports becomes stale. **Add a checkbox to each PR description: "CLAUDE.md updated — Y/N/n-a".**

---

## 6. Sign-off verdict matrix per phase + per PR

Legend: SAFE = safe to ship after the listed conditions; NEEDS-WORK = scope must change; BLOCK = decision required before PR can start.

| Phase | PR | Verdict | Required decisions/conditions |
|---|---|---|---|
| 1 | A-PR1 | NEEDS-WORK | C-5 (3rd jail point), C-6 (vars rule), C-7 (drop `/tmp` default). Without these, the PR ships a security-headline ("traversal blocked") that is materially false on the chained path + on a ../-via-vars exploit. |
| 1 | A-PR2 | SAFE-AFTER-DECISION | DP-2 must be resolved (C-1). Add `parseGithubShorthand` validation (R2 M-2 :149-158). Add `httpsGet` redirect-allowlist (R2 I-2 :252). Per-route body caps over flat 256 KB (R2 M-1). Lower-stakes amendments. |
| **1** | **A-PR4** | **PROMOTE** | Move from Phase 2. DP-1 must be resolved (C-1). Without A-PR4, Phase 1's "stop the bleed" claim is false. |
| 2 | B-PR1 | NEEDS-SPLIT | C-8 (split into 1a + 1b). Plan as written is largest PR + crosses bridge/dashboard boundary + has wrong `observeStep` ordering claim (R1 R1 + V1). |
| 2 | (A-PR4 if not promoted) | BLOCK | Same as above. |
| 3 | C-PR1 | SAFE-AFTER-DECISION | DP-5 + verify `$result` exists (R3:230). Otherwise small + correct. |
| 3 | C-PR2 | NEEDS-SPLIT | R3:507 — split into 3 (enumeration parity / scaffold UX / log hygiene). Add B-cli #31 (round-1 dropped finding R3:50). Defensible to ship as one PR if reviewer time isn't a constraint. |
| 3 | C-PR5 | SAFE | DP-8 = auto-emit. Add property-test for alias collision (R3:262). Otherwise solid. |
| 3 | C-PR6 | SAFE | DP-3 needs resolution (C-1) for the schema cap value. Otherwise small. |
| 4 | A-PR3+B-PR2 (combined) | NEEDS-WORK or RESEQUENCE | R3:303-307 — flag as largest PR. R1 R8 — could move to Phase 3b. R2 H-1 — must add `maxDepth` clamp + runtime cycle detection. R2 H-2 — add tmp-file sweeper (V8). R2 H-3 — strike `fileLock` from DP-3. |
| 5 | B-PR3 | NEEDS-WORK | R1 A3 (3rd-caller addition for scheduler + webhook). R1 B2 (taskId format breaking change — V2). R1 R7 (lint/schema gap for JSON `kind:prompt`). R3 X8 (F6/F7/F8 silent-fail bypass shapes — V6/V12). |
| 5 | B-PR4+C-PR4 (combined) | BLOCK | C-2 (PLAN-B vs PLAN-C URL extension contradiction). Without this, the combined PR contradicts itself. |
| 6 | C-PR3 | NEEDS-PIN | C-4 (pin I-e2e seams #3-#6, #9). DP-4 estimate revision (R3:218 — 1 senior week, not 3-4 days). Risk reclassification HIGH not LOW-MEDIUM. |
| 6 | A-PR5 | SAFE | Pure fixture promotion. Should ship in Phase 1, not Phase 6 (so security regression tests exist in repo from week 1, not week 6 — R2 M-4 implicitly suggests). |

**Recommendation**: 5 of 12 PRs need scope/spec changes before opening; 4 need maintainer decisions. None are unsalvageable.

---

## 7. Pre-ship checklist for the maintainer (run BEFORE merging Phase 1)

### Tests that must pass

1. `npm test` (vitest) — full suite, **708/0/0** baseline (per dogfood K-verify.md). New tests in A-PR1 + A-PR2 + A-PR4 (if promoted) bring total to ~720+.
2. `cd vscode-extension && npm run build` — extension bundles cleanly. Bump version per CLAUDE.md "Extension versioning rule" if .vsix will be installed.
3. `npx biome check src/recipes/resolveRecipePath.ts src/recipes/tools/file.ts src/recipeRoutes.ts` — formatter/linter clean before stage.
4. `npm run build` — `dist/` regenerates with new code.
5. `node scripts/audit-lsp-tools.mjs` — outputSchema audit clears (no new uncovered tools).
6. **New live-PoC regression suite** — under `docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures/` (A-PR5, promote to Phase 1):
   - `escapes-via-traversal.yaml` — assert: throws `recipe_path_jail_escape`
   - `escapes-via-symlink.yaml` — assert: throws
   - `template-traversal.yaml` (with `vars: {target: "../../../etc/x"}`) — assert: 400 at HTTP entry **AND** throws at runtime if entry is bypassed
   - `outer-chained-traversal.yaml` — assert: load throws, no inner recipe ran
   - `install-ssrf-internal.test.ts` — POST `/recipes/install` with `https://169.254.169.254/...` → 403
7. **Coverage gate**: 75% lines, 70% branches, 75% functions on changed files. Plan-A's PR-1 + PR-2 should exceed this trivially given test budget; verify per-file.

### Manual verifications required

8. Restart the running bridge (`PID 56865` per A-live-runs.md:3) before Phase 1's first PR opens. Bug #12 (bridge staleness) means stale V8 modules will mask Phase 1's fixes if not restarted. **This is non-optional — without a restart, regression tests pass but the bridge under audit still has the bug.**
9. Confirm `dist/` is rebuilt fresh **after each PR merge**. M-4 above — pin a `dist/` mtime check to the bridge's `getBridgeStatus`.
10. Run `recipe run` on each of the 12 dogfood-tested recipes (A-live-runs.md Task 2) post-Phase 1 — confirm none break.
11. Run the explicit F-01 / F-02 / F-04 / F-05 PoCs from G-security.md against the live bridge — confirm 403/400/throws as appropriate.
12. Dashboard parity check: open `/recipes`, `/runs/<seq>`, `/traces` — confirm shapes match live bridge per Agent E (E-tests-dashboard.md).

### Decision-doc approvals required

13. The 9 maintainer decisions in PLAN-MASTER §"Maintainer decisions" written into a single decision doc with **resolved answers** and signed off (C-1).
14. The PLAN-B vs PLAN-C URL-extension contradiction resolved (C-2) — pin the answer to PLAN-MASTER:56.
15. F-03 sidecar decision (DP-1) resolved AND A-PR4 promoted to Phase 1 (C-3).
16. ADR-0006 (recipe runlog versions) drafted and merged before B-PR1b opens (M-6).
17. CLAUDE.md updated with Phase 1 outcomes (per CLAUDE.md "Documentation & memory" rule).

### Backup / rollback rehearsals required

18. **Git tag `pre-phase-1-2026-05-01`** before Phase 1's first commit. `git tag pre-phase-1-2026-05-01 8f90817` (current HEAD).
19. **Rehearse `git revert` on a single Phase 1 PR**: locally revert A-PR1 after merge, run live-PoC suite, confirm exploits re-open. Validates rollback path.
20. **`~/.patchwork/recipes/` snapshot** before A-PR4 ships (sidecar deletion is destructive metadata). `tar czf ~/patchwork-recipes-pre-A-PR4.tar.gz ~/.patchwork/recipes/`. PLAN-MASTER:134 calls for `~/.patchwork/recipes/.permissions-archive/` directory; prefer the tarball as it's atomic.
21. **Migration script** for B-PR3's JSON-prompt → YAML-lower transition: dry-run on installed recipes, capture proposed diffs, store in `docs/dogfood/recipe-dogfood-2026-05-01/migration-2026-05/`. M-3 above.

---

## 8. Top 3 risks the maintainer should accept or refuse

### Risk 1 (HIGH) — `runlogVersion: 2` ships without a feature flag

**What**: B-PR1b lands; from that moment, every new recipe run is written as v2. Old runs stay v1. Dashboard / ctxQueryTraces / replayRun must read both. The "version-branched dashboard reader" PLAN-MASTER:132 implies does not exist (R1:131); B-PR1b must include it (per C-8/C-9).

**Failure mode**: B-PR1b ships, dashboard breaks for all run-detail pages, user must downgrade or hand-write a reader. Reverting B-PR1b leaves a few v2 records in the log (the ones written between merge and revert) that v1-only readers cannot parse.

**Mitigation if accepted**: ship B-PR1b's dashboard reader as part of the same PR (no temporal gap). Add `runlogVersion` parsing to ctxQueryTraces in the same PR. Tag pre-merge `runLog.json` with timestamp; document downgrade path as "filter records by `runlogVersion === 1`".

**Recommend**: ACCEPT with mitigation. The architectural win (delta over full snapshot, ~100KB → ~26KB per run) is real.

### Risk 2 (HIGH) — Phase 6 trigger-wiring (C-PR3) lands and re-fire storms break the user's day

**What**: PLAN-C C-PR3 wires YAML-declared `on_file_save`, `on_test_run`, `on_recipe_save`, `git_hook` into the orchestrator's automation hooks (PLAN-C:269-313). Today these are dormant — round-1 #6. After C-PR3, every save / test-run / git-hook on the user's workspace fires whatever YAML triggers say.

**Failure mode**: a user with `lint-on-save`, `watch-failing-tests`, `ambient-journal` recipes sees a deluge of Claude tasks queued up the moment C-PR3 ships. R3:222 reclassified C-PR3 risk to HIGH (PLAN-MASTER labels LOW-MEDIUM). CLAUDE.md says cooldownMs min 5000 — that's 5 seconds between fires. A `Cmd+S` storm of 10 saves in 2 seconds = 10 queued tasks if cooldown isn't honored at the right level.

**Mitigation if accepted**: ship C-PR3 in a narrow rollout — opt-in via `--enable-yaml-triggers` flag for the first release, default-on in the next. Or: enforce per-event cooldown at the registry level, not per-recipe (defense in depth).

**Recommend**: ACCEPT with opt-in flag for first release. Without the flag, the user's day-1 experience post-C-PR3 is "my IDE became a slot machine."

### Risk 3 (MEDIUM) — F-tools F6/F7/F8 silent-fail bypasses survive B-PR1's wiring

**What**: R3:72-78 + R3:501. After B-PR1's `detectSilentFail` ships, three known shapes still slip:

- `linear.createIssue` returning `{error: "..."}` (no `ok`, no `count/items`)
- `gmail.getMessage` / `jira.get_issue` scalar error envelopes
- yamlRunner JSON short-circuit requires `ok===false` (`{"error":"..."}` without `ok` field passes as success)

**Failure mode**: user runs a recipe that calls `linear.createIssue`, the connector returns `{error: "Token expired"}`, the recipe's downstream step receives `{error: ...}` as if it were Linear data, the recipe writes "Linear issue created: undefined" to the inbox, no error surfaced. R3 cites this as the biggest coverage gap in the master plan.

**Mitigation if accepted**: in B-PR1a, generalize `detectSilentFail` to flag any tool result containing `error:` field at the top level (regardless of `ok`/`count`/`items`). One-line generalization. OR canonicalize all 7 connector files (notion / confluence / zendesk / intercom / hubspot / datadog / stripe + 38 tools per F-tools.md F2) to emit a uniform error envelope. The latter is PLAN-D scope (PLAN-MASTER:147 — explicitly out of scope here).

**Recommend**: ACCEPT-WITH-CHANGE. Generalize the detector in B-PR1a; defer connector canonicalization to PLAN-D. The plan already says PLAN-D is needed; promote one-line generalization into B-PR1a so the silent-fail floor is real on day 1.

---

## 9. Files referenced

Every claim in this review traces back to one or more of:

- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/PLAN-MASTER.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/PLAN-A-security.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/PLAN-B-runners.md` (cited via R1/R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/PLAN-C-schema-cli.md` (cited via R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/REVIEW-1-architecture.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/REVIEW-2-security.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/REVIEW-3-completeness.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/A-live-runs.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/README.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/F-tools.md` (cited via R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/G-security.md` (cited via R2/R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/H-http-routes.md` (cited via R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/I-e2e.md` (cited via R1/R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/K-verify.md` (cited via R3)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/CLAUDE.md` (project rules — version numbers, build & test, security model)
