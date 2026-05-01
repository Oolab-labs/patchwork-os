# REVIEW-3 — Completeness audit + skeptical review of master plan

**Subject**: `PLAN-MASTER.md` + `PLAN-A-security.md` + `PLAN-B-runners.md` + `PLAN-C-schema-cli.md`.
**Method**: walked every distinct finding from rounds 1 & 2 against the plans; cited every claim to `file:line`.
**Verdict (TL;DR)**: **amend-and-ship**, not ship-as-is. The plan covers the high-severity bleeders, but **8 round-2 findings are claimed-but-not-actually-pinned** (most concentrated in I-e2e and H-routes), one of the nine "maintainer decisions" is materially mis-stated, two PRs (B-PR1, C-PR2) are bigger than the plan acknowledges, and Phase 1 alone does **not** stop the bleed because F-03 (permissions theatre) lives in Phase 2.

The five most important amendments are listed at the bottom of §5.

---

## 1. Coverage matrix

Status legend: **C** = covered (cite present in a plan), **P** = partial (mentioned but underspecified or scope leaks), **N** = not covered, **D** = explicitly deferred out of scope.

### 1.1 Round-1 28-bug list (`README.md:42-79`)

| # | Bug | Plan location | Status |
|---|---|---|---|
| 1 | Chained `hasWriteSteps:false` | PLAN-MASTER:49 (combined PR Phase 4) + PLAN-B:140-158 (B-PR2) + PLAN-A:108-110 (PR-3) | **C** |
| 2 | `detectSilentFail` not in chained | PLAN-B:108-141 (B-PR1) + PLAN-MASTER:31 | **C** |
| 3 | Schema/parser/validator disagree on triggers | PLAN-C:316-323 (C3 reconcile) + PLAN-MASTER:64 | **C** |
| 4 | `recipe list` 1-of-N | PLAN-C:158-167 (C2 widen scanDir) + PLAN-MASTER:41 | **C** |
| 5 | Install/test exit codes accept malformed YAML | PLAN-C:209-218 (C2 install-time preflight) | **P** — preflight test files split. `recipe test` exit code is in K-verify "PARTIALLY-FIXED"; install-half is in C2. NOT pinned: `recipe run --dry-run` exits 0 with `lint.errors` (B-cli #31). |
| 6 | YAML-trigger recipes never auto-fire | PLAN-C:269-313 (C3 Option A) + PLAN-MASTER:64 | **C** |
| 7 | `recipe new` template fails own lint | PLAN-C:168-176 (C2) | **C** |
| 8 | 100% lint false-positive | PLAN-C:60-103 (C1) + PLAN-MASTER:40 | **C** |
| 9 | VD-2 chained-only | PLAN-B:108-141 (B-PR1) | **C** |
| 10 | Cron uses local TZ | PLAN-C:325-336 (C3) | **C** |
| 11 | `morning-brief` silent agent skip | PLAN-B:108-141 (B-PR1 chained-side) | **C** (yaml-side already shipped per K-verify; chained-side via B-PR1) |
| 12 | Bridge staleness | n/a — operational, "FIXED-BY-RESTART" per K-verify | n/a |
| 13 | `nestedRecipeStep` off-by-one | PLAN-C:337-342 (C3) | **C** |
| 14 | `daily-status` shadow | PLAN-MASTER:56 + PLAN-B:206-225 (B-PR4) + PLAN-C:421-454 (C4) | **C** |
| 15 | `/recipes/:name/runs` (and 5 more nested routes) | PLAN-C:457-475 (C4 four-of-six) + PLAN-MASTER:56,124 | **P** — only 4 of 6 routes; 2 stay 404. Plan justifies via DP-3 but does NOT note that round-1 specifically enumerated `/recipes/:name/runs` — that one IS in the four-land set, so #15 itself is closed. **OK.** |
| 16 | `kind:prompt` JSON lint-fail / schema-fail / executes | PLAN-B:163-202 (B-PR3) | **C** (but see below — schema-side Round 1 D F7 acknowledged-not-fixed in PLAN-B:300) |
| 17 | `recipe run <name>` subdir | PLAN-C:188-196 (C2) | **C** |
| 18 | PR #93 Jira+Sentry tests | PLAN-C:556-575 (C5) | **C** |
| 19 | PR #103 camelCase aliases | PLAN-C:521-555 (C5) | **C** |
| 20 | `recipe new --help` → `--help.yaml` | PLAN-C:172-181 (C2 dash guard) | **C** |
| 21 | `quick-task` raw `DOMException` | PLAN-C:613-619 (C6) | **C** |
| 22 | `replayRun` no CLI | PLAN-C:621-624 (C6) | **C** |
| 23 | `parser.ts` dead | PLAN-C:90-103 (C1) | **C** |
| 24 | `output:` deprecation per load | PLAN-C:198-208 (C2 dedup) | **P** — dedup hides the symptom; recipes still emit `output:`. Plan-C:728-731 acknowledges. |
| 25 | `registrySnapshot` per-step bloat | PLAN-B:108-141 (B-PR1 delta) + PLAN-MASTER:31 | **C** |
| 26 | `recipe`/`recipe --help` silent | PLAN-C:182-191 (C2) | **C** |
| 27 | apiVersion warning 3× | PLAN-C:198-208 (C2 dedup) | **C** |
| 28 | starter-pack `event:` | PLAN-C:344-358 (C3) | **C** (move to `_vision-tier`) |

**Round-1 totals**: **C=24, P=3, N=0** (note: #5 split-counted as P because the run-dry-run exit-code half is unaddressed; #15 is P only because the plan is honest about deferring `/preflight` + `/lint`, which is fine; #24 is P by design).

**Round-1 dropped findings: 1.** `recipe run --dry-run` exits 0 even when `lint.errors` populated (`B-cli.md:113`, B-cli #31). PLAN-C C2 fixes the install-half of #5 but says nothing about exit-code unification across `dry-run`/`test`/`lint`/`preflight`. This is a real CI silent-pass risk and was flagged by Agent B. **Add to C2 or C6.**

### 1.2 Round-2 F-tools — five "Critical findings (new)"

The F-tools.md report has five severity-CRITICAL/HIGH new findings at lines 300-322:

| F-id | Bug | Plan location | Status |
|---|---|---|---|
| F1 | `file.read/write/append` no jail | PLAN-A:24-60 (PR-1) | **C** |
| F2 | 7 connector files no try/catch | PLAN-MASTER:147-148 — explicitly out of scope, "PLAN-D suggested" | **D** |
| F3 | Chained runner no `detectSilentFail` | PLAN-B:108-141 (B-PR1) | **C** |
| F4 | PR #103 camelCase 2-of-36 | PLAN-C:521-555 (C5) | **C** |
| F5 | PR #93 zero unit tests | PLAN-C:556-575 (C5) | **C** |
| F6 | `linear.createIssue/updateIssue` bare `{error}` | NOWHERE | **N** |
| F7 | Scalar-read error envelopes slip detector | NOWHERE | **N** |
| F8 | yamlRunner JSON short-circuit requires `ok===false` | NOWHERE pinned (Plan-B B-PR1 *might* incidentally fix this if `observeStep` re-checks the contract, but plan-B:108-141 only documents the silent-fail path, not this gate) | **P/N** |
| F9 | PR #103 alias mechanism naïve (no central emit) | PLAN-C:521-555 (C5 — central emit) | **C** |
| F10 | `notify.push` doesn't exist | NOWHERE | **N** |
| F11 | `meetingNotes.flatten` weak input validation | NOWHERE | **N** |
| F12 | `github.list_issues` 2348ms via `gh` shell | NOWHERE — perf, low priority | **N** |
| F13 | `diagnostics.get` placeholder no parens | NOWHERE | **N** |

**F-tools dropped findings: 5** (F6, F7, F8, F10, F11 — F13 is acceptable to drop, F12 is perf-only). The F6 + F7 + F8 trio is significant — it means even after B-PR1 wires `detectSilentFail` into chained, three known shapes still slip past:

- `linear.createIssue` returning `{error: "..."}` (no `ok` field, no `count/items`) — bypasses both yamlRunner JSON-error short-circuit AND `detectSilentFail`. (`F-tools.md:229`, `:314`)
- `gmail.getMessage` / `jira.get_issue` / scalar-read error envelopes — same bypass. (`F-tools.md:228`, `:317-319`)

PLAN-MASTER §"What this plan does NOT cover" mentions only F2 (the 7 connector files). The plan **does not acknowledge** F6/F7/F8/F10/F11. This is the single biggest coverage gap in the master plan.

### 1.3 Round-2 G-security — 13 findings

| F-id | Sev | Bug | Plan location | Status |
|---|---|---|---|---|
| F-01 | CRITICAL | file.* path traversal | PLAN-A:24-60 (PR-1) | **C** |
| F-02 | CRITICAL | template-driven traversal | PLAN-A:24-60 (PR-1) | **C** |
| F-03 | CRITICAL | permissions sidecar theatre | PLAN-A:140-164 (PR-4) + PLAN-MASTER:32 | **C** |
| F-04 | HIGH | chained `recipe:` accepts arbitrary | PLAN-A:62-98 (PR-2) | **C** |
| F-05 | HIGH | `/recipes/install` SSRF | PLAN-A:62-98 (PR-2) | **C** |
| F-06 | HIGH | concurrent runs race-overwrite | PLAN-A:101-137 (PR-3) | **C** |
| F-07 | HIGH | hasWriteSteps blind to chained | PLAN-A:101-137 + PLAN-MASTER:49 | **C** |
| F-08 | MED | request body unbounded | PLAN-A:62-98 (PR-2) | **C** |
| F-09 | MED | maxConcurrency unbounded | PLAN-A:101-137 + PLAN-C:625-628 + PLAN-MASTER:11 | **C** |
| F-10 | MED | CLI accepts arbitrary path no warning | PLAN-A:24-60 (PR-1) | **C** |
| F-11 | LOW | template serialize unscaped | NOWHERE (acknowledged in PLAN-A:222-228 as deferred docs note) | **D** (defensible, but should land an explicit lint rule per PLAN-A's own recommendation) |
| F-12 | LOW | install master-fallback | PLAN-A:230-236 — INFO/safe | n/a |
| F-13 | INFO | stream-HTTP register parity | already fixed | n/a |

**G-security totals: C=10, D=1, n/a=2.** All CRITICAL+HIGH+MED items covered.

### 1.4 Round-2 H-routes — "NEW CRITICAL", "NEW HIGH", 6 missing routes

| Bug | Plan location | Status |
|---|---|---|
| **NEW CRITICAL** PATCH ESM `require is not defined` | PLAN-C:392-419 (C4) | **C** |
| HIGH 2 — `/recipes/install` SSRF + 500-on-404 | PLAN-A:62-98 (PR-2) — SSRF + body cap; **404→500 mapping** noted in PLAN-A:80 ("Return 4xx (not 500) for fetch failures") | **C** |
| HIGH 3 — body schema unvalidated (`args:` silently dropped, `vars: []` coerced) | PLAN-A:35 (`vars` keys/values via regex) | **P** — covers `vars` only. **Does NOT add an unknown-field rejector.** `args:` silently dropped is unaddressed. (PLAN-C:13 punts to PLAN-A; PLAN-A doesn't cover the unknown-key half.) |
| HIGH 4 — registrySnapshot bloat | PLAN-B:108-141 (B-PR1 delta) | **C** |
| HIGH 5 — `/recipes/:name/runs` missing | PLAN-C:464 (C4) | **C** |
| HIGH 6 — JSON-prompt no `recordRecipeRun()` | PLAN-B:163-202 (B-PR3) | **C** |
| MED 7 — `daily-status` two-layer disagreement | PLAN-B:206-225 (B-PR4) + PLAN-C:421-454 (C4) | **C** |
| MED 8 — `/runs/:seq/plan` 503-vs-404 mapping | NOWHERE | **N** |
| MED 9 — recipe count fresh vs round-1 | n/a — accounting note | n/a |
| MED 10 — `/templates` 5-min cache no single-flight | NOWHERE | **N** |
| MED 11 — `/activation-metrics` opt-out signal | NOWHERE | **N** |
| MED 12 — POST `/recipes/run` lenient body parsing | tied to HIGH 3 — not addressed beyond `vars` | **N** |
| LOW 13 — `/recipes/lint` 200 not 400 | NOWHERE | **N** |
| LOW 14 — `/runs?status=bogus` silently 200 | NOWHERE | **N** |
| LOW 15 — `/recipes/install` predictable `/tmp/` filename TOCTOU | NOWHERE | **N** |
| Missing routes #1-6 | PLAN-C:457-475 (C4) — 4 of 6 land, 2 stay 404 with docs | **C** (per DP-3) |

**H-routes totals: C=9, P=1, N=6, n/a=2.**

**H-routes dropped findings: 6** (Bug 8, 10, 11, 12, 13, 14, 15 — net 6 because 9 + 12 collapse). Most are LOW/MED but Bug 12 is the same lenient body parsing that LOW-13 noted in round-1 and is the most user-impactful: `args:` silently dropped is an explicit prompt-failure mode for any third-party API consumer. **Plan-A PR-1's `vars` validation does NOT close this** — it validates the inside of `vars` but not unknown top-level keys.

### 1.5 Round-2 I-e2e — 16 seams

| # | Sev | Seam | Plan location | Status |
|---|---|---|---|---|
| 1 | CRITICAL | chained `hasWriteSteps:false` | covered (= round-1 #1) | **C** |
| 2 | CRITICAL | nested-recipe maxDepth off-by-one | PLAN-C:337-342 (C3) | **C** |
| 3 | CRITICAL | no inter-recipe call cycle detection | PLAN-MASTER:64 ("nested cycle detection") + PLAN-A:120 ("Cycle detection already exists at chainedRunner.ts:993-1009") | **P** — Plan-A's claim is **wrong**: chainedRunner's cycle detection is intra-recipe DAG cycles (verified in `C-triggers.md:62-63`), NOT inter-recipe. The actual fix is missing — there's no plan-pinned name-tracker for nested recipe stack. PLAN-MASTER:112 lists it as "folds into trigger-wiring work" (C-PR3) but C-PR3's actual scope (`PLAN-C:269-358`) does not pin it. **N — missing in PLAN-C C3.** |
| 4 | HIGH | cron-installed-post-startup never fires | PLAN-MASTER:64 ("cron-installed-post-startup") | **N** — same as #3 above; Master claims C-PR3 covers it but C-PR3's pinned scope (`PLAN-C:269-358`) only has scheduler timezone + nestedRecipeStep + automation registry. **No scheduler-reload mechanism pinned anywhere.** Verified via grep — `src/recipes/scheduler.ts` has no `reload()` method (confirmed live). |
| 5 | HIGH | duplicate `name:` → both unreachable via `/recipes/<name>/run` | PLAN-MASTER:112 ("duplicate-name") — claimed C-PR3 | **N** — Master claim has no PLAN-C anchor. PLAN-B:206-225 (B-PR4) addresses YAML-vs-JSON name collision but NOT same-extension same-name from two install dirs. |
| 6 | HIGH | multi-yaml package: only one recipe registered | PLAN-MASTER:112 ("multi-yaml drop") — claimed C-PR3 | **N** — same gap as #5. C-PR2 widens `listInstalledRecipes` (PLAN-C:158-167) but does not address the registry's one-per-dir limit. |
| 7 | HIGH | VD-2 missing from yamlRunner | PLAN-B:108-141 (B-PR1) | **C** |
| 8 | HIGH | recipe install accepts malformed YAML | PLAN-C:209-218 (C2 preflight) | **C** |
| 9 | HIGH | nested child runs not in `/runs` | NOWHERE | **N** |
| 10 | MED | `--allow-write` singular vs `--allow-writes` plural arg-eating | NOWHERE | **N** |
| 11 | MED | examples use bare `{{threads}}` flat-key refs | PLAN-C:344-358 (C3) — but only `event` triggers; flat-key refs across non-event examples NOT addressed | **P** |
| 12 | MED | nested child failure → `childOutputs: {}` | NOWHERE | **N** |
| 13 | MED | CLI `recipe enable <yaml-name>` rejects | NOWHERE | **N** |
| 14 | MED | registrySnapshot duplicated (= round-1 #25) | covered | **C** |
| 15 | LOW | manual fire of cron recipe logs `trigger:"cron"` | NOWHERE | **N** |
| 16 | LOW | replay yaml-rejected, chained-accepted | working as designed | n/a |

**I-e2e totals: C=6, P=2, N=7, n/a=1.** **Seven I-e2e seams unaddressed** (#3, #4, #5, #6, #9, #10, #12, #13, #15 — actually 8 if you count #11 as fully N). PLAN-MASTER:95-113 explicitly **claims** to cover #3, #4, #5, #6 via "Phase 6 (C-PR3)"; PLAN-C C-PR3 does not actually pin these.

### 1.6 K-verify status table

K-verify is a re-verification, not a new findings list. Its `STILL-BROKEN` set (`K-verify.md:227-256`: 13 bugs) is a subset of round-1 + restart-fixed. Already counted. The 12 `NOT-RE-VERIFIED` items in K-verify (`K-verify.md:240-252`) are out-of-scope per the K-verify task and don't affect plan coverage.

### 1.7 Coverage matrix summary

| Source | Total | C | P | N | D | Drop |
|---|---:|---:|---:|---:|---:|---|
| Round-1 28-bug | 28 | 24 | 3 | 0 | 0 | 1 (B-cli #31 dry-run exit code) |
| F-tools new | 13 (F1-F13) | 5 | 1 | 5 | 1 | F6, F7, F8, F10, F11 (F12/F13 acceptable) |
| G-security | 13 | 10 | 0 | 0 | 1 | none (F-11 docs-only deferred) |
| H-routes | 17 (incl. 6 missing routes + bug 9 acct) | 9 | 1 | 6 | 0 | Bug 8, 10, 11, 12, 13, 14, 15 |
| I-e2e | 16 | 6 | 2 | 7 | 0 | Seam 3 (cycle), 4 (cron-reload), 5, 6, 9, 10, 12, 13, 15 |

**Total dropped/unaddressed findings: ~24** across all reports. Several are LOW. The HIGH-tier drops are:
- I-e2e #3 (inter-recipe cycle detection) — **PLAN-A:120 misclaims this as "already exists"**
- I-e2e #4 (cron-reload) — **Master claims C-PR3 covers it; C-PR3 doesn't**
- I-e2e #5 (dup name conflict)
- I-e2e #6 (multi-yaml registration)
- I-e2e #9 (nested child runs absent from `/runs`)
- F-tools F6/F7/F8 (silent-fail bypass shapes — even after B-PR1 lands, three known shapes still slip)
- H-routes Bug 3 (unknown-key body validation)

---

## 2. Decision-point challenges (9 maintainer decisions)

The PLAN-MASTER §"Maintainer decisions to make before Phase 1 ships" (lines 115-127) lists 9 decisions. Per-decision skeptical review below.

### DP-1: F-03 permissions — delete vs enforce (PLAN-A DP-1)

Recommendation: Option B (delete sidecar). Rationale cited: "Delete is faster + matches existing `~/.claude/settings.json` story" (PLAN-MASTER:119).

**Challenge**: this is the single weakest "do less" recommendation in the plan.

- The PLAN-A DP-1 table (`PLAN-A.md:215-225`) understates Option A's value. Migration risk for Option A is "high" because empty-`allow` arrays would deny-everything — but **the same cost block is hand-waved** as "MUST add a default-allow fallback when … all empty". That's a 5-line fix, not "high migration risk."
- The "rollback hard" claim for Option A misreads the operator workflow. If Option A ships and a bug requires reverting, the sidecar files survive — the operator's `deny: ["Bash(*)"]` lists are still on disk, the runtime is just no longer enforcing them. That's the **same** end-state as today (sidecars decorative). Rollback is trivial.
- The 600-LOC vs 50-LOC cost gap is real but the 600-LOC payload includes the matcher engine — useful work that the Patchwork roadmap will need anyway when fine-grained permissions ship for `kind:prompt` recipes.

**Third option not listed**: Option C — **delete sidecar AND add the 30-line enforcement layer over an existing simple matcher** (e.g. read `denyToolPatterns: string[]` from a single `recipes/permissions.json` or recipe front-matter). This avoids the matcher-engine cost while still giving honest enforcement. Cheaper than Option A, more honest than Option B.

**Concrete failure scenario for Option B**: an operator audits the dashboard, sees `branch-health` has `hasPermissions: false` (because we deleted the sidecar), assumes that's fine because the dashboard told them. Six months later the operator installs `dangerous-recipe.json` from a third-party. There's no signal in the dashboard that this recipe is unconstrained — they can't tell "no permissions ever existed" from "permissions deleted as policy." Today (sidecars decorative) at least the dashboard surfaces the badge so the operator's instinct to inspect is preserved.

**Recommendation: keep Option B as default, but make sure the dashboard explicitly states "Patchwork does not enforce per-recipe permissions; configure tool gating in `~/.claude/settings.json`" so the absence of a badge is intentional. Without that copy change, Option B silently shifts safety responsibility to the operator without informing them.**

### DP-2: F-05 install allowlist — strict vs `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS`

Recommendation: env-var-default-empty (effectively github-only).

**Challenge**: tradeoff stated correctly. One sub-issue:

- The default-empty env var means the variable is "configurable but probably never configured." **Concrete failure**: a corporate user runs Patchwork on a self-hosted recipe registry at `recipes.internal.acme.com`. Default-deny blocks it. They set `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS=recipes.internal.acme.com`. SSRF defense from `sendHttpRequest` (PLAN-A:80) doesn't filter that env-var-allowed host's resolved IP. If `recipes.internal.acme.com` happens to resolve to a 169.254.x or RFC1918 address, the SSRF check should still trigger.

**Sub-recommendation**: the SSRF DNS-resolution check must run **after** env-var allowlist match, not before. Plan-A:80 says the SSRF guard wraps `fetch(fetchUrl)` — order is ambiguous. Make it explicit in PR-2's tests.

### DP-3: F-09 maxConcurrency — 8 vs 16 vs 32

Recommendation: 16, warn above 8.

**Challenge**: tradeoff stated correctly. Plan-A:241-247 captures the math (16 × 30s × ~10 KB working set, 32 risks fd exhaustion).

- **One concern not noted**: the cap is at *recipe* level, not at *bridge* level. A bridge can run multiple chained recipes concurrently (e.g. webhook fan-in). 4 webhooks each firing a `maxConcurrency: 16` recipe → 64 in-flight LLM calls. Bridge-wide cap should be the same number or higher.
- **Concrete failure**: cron runs `branch-health` at minute 0; webhook fires `morning-brief` at minute 0:01; both have `maxConcurrency: 16`. Bridge briefly carries 32 in-flight steps. With 32 sockets pinned to LLM endpoints, a third recipe waiting on cron at 0:02 stalls. Plan does not address bridge-wide concurrency cap.

**Recommendation: keep 16, but note in PR-3 description that this is per-recipe; bridge-wide is bounded by Node's default 100 sockets and is not addressed in this plan.**

### DP-4: #6 trigger wiring — wire to orchestrator vs drop trigger types

Recommendation: Option A (wire to orchestrator).

**Challenge**: PLAN-C:268-313 is reasonable. One issue:

- PLAN-C estimates Option A at "~3-4 days" (`PLAN-C:307`). The actual scope listed (`PLAN-C:286-298`) is: extend `compiler.ts` switch (~30 LOC), build `RecipeAutomationRegistry` (a new class, ~150 LOC), wire startup walk + hot-reload + dedup (~80 LOC), plus tests (~180 LOC). **Realistic estimate: 1 senior week with bug fixes, not 3-4 days.**
- The cost is fine but the **dependency chain is mis-stated**. PLAN-MASTER places C-PR3 in Phase 6 "now safe because Phase 2 silent-fail floor is in place" (PLAN-MASTER:60). This implies trigger wiring depends on B-PR1 silent-fail. **It does not** — newly-firing triggers will still misbehave on the YAML runner before silent-fail wiring lands, but they'll at least *fire*. The dependency is convenience, not correctness; trigger wiring could land in Phase 3 or 4.

**Concrete failure of the recommendation**: maintainer looks at "Phase 6, week 6" and assumes 1 PR. Reality is C-PR3 is 7 files + 5 new test files + a new in-process registry, with 2 day-1 risks (re-fire storms on file-watch hot-reload, race between scheduler and registry on cron triggers). **Should be flagged HIGH risk in PLAN-MASTER:130-136 risk section, not just LOW-MEDIUM.**

### DP-5: #8 lint whitelist — explicit 5-root vs any-dotted-path

Recommendation: explicit 5-root `{steps, env, vars, recipe, $result}`.

**Challenge**: this is correct.

- Tradeoff captured well in PLAN-C:104-115. The concrete failure scenario for "any-dotted-path" is well-pinned (`{{steeps.X.data}}` typo).
- One sub-issue: PLAN-MASTER:124 lists 5 roots (`steps, env, vars, recipe, $result`) but PLAN-C:62-63 lists the same 5. **`$result` is unusual** — none of the four reports cite a recipe using `$result`. Verify it's actually a runtime-recognized root before whitelisting it; otherwise we're adding a syntactic root that lint accepts but no runner resolves, which is the same class of bug as the lint-runtime divergence we're closing.

**Recommendation: confirm `$result` exists in the runtime by grepping templateEngine + yamlRunner. If not, drop it from the whitelist (4-root set).**

### DP-6: #14 daily-status — YAML-wins + explicit-extension URL

Recommendation: YAML-wins, explicit-extension as override.

**Challenge**: PLAN-MASTER:125 simplifies away the URL-disambiguation half. Plan-C:421-454 has it. Plan-B:206-225 (B-PR4) re-derives it. Three parallel mentions but no single source of truth — risk of merge skew.

- **Concrete failure**: maintainer reads PLAN-MASTER, ships YAML-wins as the only fix. Dashboard's "Run JSON variant" button breaks because there's no `/recipes/daily-status.json` URL form to trigger it.
- **Third option not listed**: rename the JSON variant on disk (PLAN-C:450-453 rejects this as "breaks bookmarks"). The objection is reasonable, but the rename would be one-time and avoids the URL-extension-disambiguation surface entirely. For a single-user dogfood scenario, this is the minimum-surface fix.

**Recommendation: PLAN-MASTER:125 should explicitly say "ship the URL extension form along with YAML-wins; otherwise dashboard JSON-variant access is dropped silently."**

### DP-7: #15 missing routes

Recommendation: 4 land, 2 stay 404, 1 docs.

**Challenge**: tradeoff well-captured (PLAN-C:457-475). The 4-land set looks right. One sub-issue:

- `POST /recipes/:name/permissions` is in the 4-land set, but per DP-1 if Option B ships (delete sidecar) this route has nothing to update. Inconsistent with DP-1.

**Recommendation: drop `POST /recipes/:name/permissions` from the land set if DP-1 = Option B. Or keep it and have it write to `~/.claude/settings.json` instead (more invasive).**

### DP-8: #19 camelCase — auto-emit in `registerTool`

Recommendation: auto-emit.

**Challenge**: this is correct. PLAN-C:526-540 is sound. No third option needed.

- One note: the regex in PLAN-C:531-536 (`def.id.includes("_") && !def.id.startsWith("_")`) would emit aliases for IDs like `tool_v2` → `toolV2`. PLAN-C:589-591 mentions edge cases. This is correct but should add a property test that asserts no alias collision (e.g. two tools named `foo_bar` and `fooBar` both register and one wins silently).

### DP-9: #23 dead `parser.ts` — delete

Recommendation: delete.

**Challenge**: this is correct.

- One concern: `parser.test.ts` has 14 test cases (per `E-tests-dashboard.md` section 1.1). Plan-C:54-56 says "delete or rewrite to target `legacyRecipeCompat.normalizeRecipeForRuntime`." Coverage is non-trivially shifted; verify the rewritten tests exercise the same edge cases (parsedRecipe vs renderTemplate) before deletion.

---

## 3. Sequencing audit

Master plan claims 6 phases with hard dependencies. Per-claim audit:

### 3.1 "Phase 1 stops the bleed" (PLAN-MASTER:18-25)

**Claim**: A-PR1 + A-PR2 close path traversal + SSRF; "live-PoC traversal exploits blocked. SSRF closed. Recipe-runner is no longer a sandbox-escape primitive."

**Audit**: claim is **partially false**. Phase 1 does not close F-03 (permissions theatre — `G-security.md:80-96`, CRITICAL). F-03 is in Phase 2 (PLAN-MASTER:32, A-PR4). Until A-PR4 lands, an operator who reads the `*.permissions.json` sidecar and trusts `deny: ["Bash(*)"]` is still at risk. **The bleed is not stopped at week 1; it's stopped at week 2.**

**Verdict**: amend PLAN-MASTER:25 to "Phase 1 closes traversal + SSRF + body cap. F-03 permissions theatre still active until Phase 2 (A-PR4); operators should not trust `*.permissions.json` sidecar files until then."

Or, alternatively: **promote A-PR4 to Phase 1**. A-PR4 is independent of A-PR1/A-PR2 (verified by reading PLAN-A:140-164 — Option B is a 50-LOC removal in `installer.ts`). It can ship same week.

### 3.2 "B-PR1 is load-bearing for Phase 4-5" (PLAN-MASTER:29-31)

**Claim**: "B-PR1 is **load-bearing** for everything in Phase 4-5."

**Audit**: partially true.
- B-PR2 (chained `tool` field in plan) does NOT depend on B-PR1 — it's a 5-line plan-builder change. PLAN-B:308-313 explicitly says "B2 | none (independent of B1; can ship in either order)."
- B-PR3 (lower JSON-prompt to YAML) genuinely depends on B-PR1 for VD-2 + silent-fail to apply. (PLAN-B:312)
- B-PR4 (canonical resolver) does NOT depend on B-PR1 — it's pure resolver layer. PLAN-B:313 says "B4 shippable without B3 but the test scenarios are simpler post-B3."
- A-PR3+B-PR2 combined (Phase 4) — the F-07 chained `hasWriteSteps` half can ship before B-PR1 (it's in B-PR2 scope).

**So**: B-PR1 is load-bearing only for B-PR3 (via VD-2/silent-fail dep). B-PR2, B-PR4, and A-PR3's F-06/F-09 halves are independent.

**Verdict**: the load-bearing claim is **overstated**. Phase 4 (combined PR) and B-PR4 from Phase 5 could land in Phase 3 alongside C-PRs without breakage.

### 3.3 "A-PR3 + B-PR2 combined" (PLAN-MASTER:48-50)

**Claim**: combine because they "share a touchpoint" on chainedRunner.

**Audit**: correct in spirit but the dedup mention in PLAN-MASTER:9 understates the change. A-PR3 alone touches `yamlRunner.ts:976-994` (atomic write), `chainedRunner.ts:1029-1036` (plan field), `recipe.ts:803-822` (recursion), `validation.ts` (lint warning), `replayRun.ts:111` (clamp). B-PR2 touches `chainedRunner.ts:991-1040` (overlapping range). Combining is sensible, but **the combined PR is now ~5 files + 4 test files**, not "one PR" — it's bigger than either A-PR3 or B-PR2 alone, by about 50%.

**Verdict**: combining is correct, but flag in PR description that this is the largest PR in Phase 4.

### 3.4 "Phase 6 needs Phase 2 silent-fail floor" (PLAN-MASTER:60-66)

**Claim**: "Now safe because Phase 2 silent-fail floor is in place."

**Audit**: **convenient sequencing, not a correctness dependency**. Trigger-wiring (C-PR3) doesn't crash without silent-fail; it just emits less useful telemetry on failure. Could land Phase 3.

**Verdict**: the dependency arrow `B-PR1 → C-PR3` in the dep graph (PLAN-MASTER:71-93) is **convenience, not correctness**. C-PR3 could land Phase 3 or 4 if maintainer wants triggers live sooner.

### 3.5 Cross-bundle dep graph — overall accuracy

PLAN-MASTER:71-93 dep graph:
- `A-PR1 → B-PR1` arrow: **wrong**. A-PR1 and B-PR1 are independent. PLAN-A:11-15 even says "PLAN-A is the critical path; runners + schema can land after."
- `A-PR2 → B-PR1` arrow: same — independent.
- `B-PR1 → A-PR3+B-PR2`: half-true. The F-07 chained side-of-fix is in B-PR2 (independent). The F-06 atomic-write half is in A-PR3 (independent of B-PR1). Combined PR doesn't actually require B-PR1.
- `B-PR1 → B-PR3`: correct.
- `B-PR1 → B-PR4+C-PR4`: weakly true. B-PR4 shippable without B-PR1 per PLAN-B:312-313.
- `B-PR1 → C-PR3`: convenience only, not correctness.

**Verdict**: the dep graph is overstated by 4 arrows. Tighter-honest version:

```
A-PR1, A-PR2, A-PR4   independent (Phase 1 — security)
B-PR1                 independent (Phase 2 — load-bearing for B-PR3 only)
B-PR2, A-PR3-write    independent (chained-plan + atomic-write)
A-PR3-recursion       depends on B-PR2 (needs tool field)
B-PR3                 depends on B-PR1 (needs VD-2/silent-fail in yaml)
B-PR4                 independent (resolver layer)
C-PR1..C-PR6          independent of A/B
C-PR3                 independent (convenience-only on B-PR1)
```

Net effect: **3 of the 6 phases could be parallelized**. The 6-week sequential schedule is conservative.

---

## 4. PR-size realism check

Plan estimates: 1,620 source LOC + 2,340 test LOC across 12 PRs (PLAN-MASTER:140-145).

### 4.1 Recent PR sizes (git log baseline)

From `git log --shortstat -20`:

| PR | Net LOC | Files |
|---|---:|---:|
| #103 (5 fixes in 1 PR) | +263 | 6 |
| #102 (extract recipe routes) | +126 | 2 |
| #114 (batch dogfood) | +1189 | 13 |
| #115 (3 fixes) | +443 | 9 |
| #122 (intellij version + signature help) | +172 | 4 |
| #110 (4 security fixes) | +150 | 4 |

**Median fix-PR: ~250-450 LOC, 4-9 files.** Recent multi-fix PRs (#103, #110, #115) hit 4-13 files routinely.

### 4.2 B-PR1 reality check

PLAN-B:108-141 lists B-PR1 scope:

1. NEW `src/recipes/stepObservation.ts` (~150 LOC) — pure module
2. `yamlRunner.ts:540-674` — refactor inline silent-fail + JSON-error logic to call observeStep; populate VD-2 fields. **~50-80 LOC of touched lines** (the area is 134 lines wide; refactor likely hits 50-60 of them)
3. `chainedRunner.ts:438-471` — wrap `executeAgent`/`executeTool`; replace `success: true` shortcut. ~30 LOC
4. `chainedRunner.ts:836-855` — replace per-step full-snapshot with delta. ~40 LOC
5. `captureForRunlog.ts` — add `captureRegistryDelta`. ~50 LOC
6. `runLog.ts:34-53` — add `registryFinalSnapshot?` + `runlogVersion: 2`. ~10 LOC
7. Tests: stepObservation.test.ts, yamlRunner-vd2.test.ts, chainedRunner-silentfail.test.ts. **5 categories of tests** per task spec — see §6.
8. **Backwards-compat dashboard reader** for `runlogVersion: 1` vs `2` (PLAN-B:338) — **not pinned to a file**. Almost certainly needs a PR change to `dashboard/src/app/runs/[seq]/page.tsx` or a `runLogReader.ts` shim.

**Estimate**: ~350 source LOC + ~600 test LOC + dashboard-side ~50-100 LOC = **~1,000 LOC across 8 files**. This is the largest PR in the plan and exceeds the "300-700 LOC per PR" target stated in PLAN-A:22.

**Realistic split**: B-PR1 should be **2 PRs**:
- **B-PR1a**: extract `stepObservation.ts`, wire into both runners. Closes #2, #9, #11-chained, half of #1. (~500 LOC)
- **B-PR1b**: registrySnapshot delta + `runlogVersion: 2` + dashboard reader. Closes #25, registrySnapshot bloat. (~350 LOC)

This separates the post-step pipeline change (high test surface) from the runlog-format change (high backwards-compat surface). Each is ~500 LOC.

### 4.3 C-PR2 reality check

PLAN-C:135-247 lists C-PR2 closing 7 bugs (#4, #7, #17, #20, #26, #27, half of #5). Files: `recipeInstall.ts` (2 changes), `index.ts` (3 changes), `legacyRecipeCompat.ts`, `migrations/*`, `commands/recipe.ts` — **6 files, 6+ tests**. Plan estimate: ~280 source LOC + ~220 test LOC.

Realistic: **the warning-dedup change alone touches 2-3 files (`legacyRecipeCompat.ts` + `migrations/*` callers + a tests-reset helper). The CLI help-text change is its own concern. The `recipe new` template fix + `--help` guard are independent of `recipe list`/`recipe run` enumeration.**

**Realistic split**: C-PR2 is reasonably 3 PRs:
- **C-PR2a**: `recipe list` widen + `recipe run` subdir resolver (#4, #17). One concept: enumeration parity. (~150 LOC)
- **C-PR2b**: `recipe new` template + dash-prefix guard + help text (#7, #20, #26). One concept: scaffold UX. (~120 LOC)
- **C-PR2c**: dedup warnings + install-time preflight (#27, half of #5). One concept: log/load hygiene. (~150 LOC)

Each ~150 LOC, focused, easy to review. The plan's single C-PR2 is 7 bugs in one ~500-LOC PR — realistic but a review burden.

### 4.4 PLAN-A PR-1 reality check

PLAN-A:24-60 — `resolveRecipePath` jail. Files: NEW jail helper, `file.ts` (3 tools), `yamlRunner.ts:976-994` + `:642`, `recipeRoutes.ts` (2 places), `recipe.ts:1080-1102`, NEW tests, `file.test.ts` NEW. **~150 LOC source per PLAN-MASTER:140; tests ~200 LOC.** Realistic for a focused security PR.

### 4.5 Total LoC reality

PLAN-MASTER claims: 1,620 source / 2,340 tests / **1.4:1 test-to-source**.

Comparing to recent fix PRs (#103, #110, #115): test-to-source ratio is closer to **0.5:1 to 0.8:1** for security/correctness fixes, **1:1** for new features with edge cases. The 1.4:1 ratio is high but achievable if every PR carries dedicated regression tests.

**Verdict**: total LoC is plausible at ~3,960 across 12 PRs (~330 per PR). With my recommended splits (B-PR1 → 2; C-PR2 → 3), total goes to ~14 PRs at ~285 LOC each. Tighter, more reviewable.

---

## 5. Out-of-scope creep risk

Per-PR creep risks:

| PR | Creep risk | What might land in review |
|---|---|---|
| A-PR1 | LOW | Reviewer might ask for symlink check on read paths too (currently only writes). 5-line addition. |
| A-PR2 | MEDIUM | Body-cap helper consolidation might tempt a refactor of all 6 readers. PLAN-A:73 already does this. |
| A-PR3+B-PR2 (combined) | HIGH | Three concerns in one PR. Reviewer might split. **Should be split anyway** — F-06 atomic-write is independent from F-07 chained-tool-field. |
| A-PR4 | LOW | If Option B, 50-LOC removal. If Option A, scope explodes — flag as decision-blocker. |
| B-PR1 | HIGH | Dashboard reader compat for `runlogVersion: 2`. Tests for `replayRun` with new shape. **Recommend split per §4.2.** |
| B-PR3 | MEDIUM | The `kind:prompt` JSON schema becomes a real schema (PLAN-B:300). Maintainer might push for a `kind:prompt`-specific validator now. Resist; defer to follow-up. |
| C-PR1 | LOW | Built-in seeding (`{{YYYY-MM-DD}}` etc.) might bring in templateEngine extension. Plan-C:80-89 already covers; ~10 LOC extra. |
| C-PR2 | HIGH | 7 bugs in one PR. **Recommend 3-way split per §4.3.** |
| C-PR3 | HIGH | New `RecipeAutomationRegistry` is ~150 LOC of new infrastructure with hot-reload + dedup. **Should ship its own PR** even within Phase 6 scope (separate from the timezone + nestedRecipeStep one-liners). |
| C-PR5 | MEDIUM | Camelcase auto-emit + Jira/Sentry tests = ~30 source LOC + ~600 test LOC. Test-heavy PR; reviewer might request integration tests too. |

---

## 6. B-PR1 test budget audit

Task-spec test categories for B-PR1:
1. **Both-runners parity tests for VD-2 capture** — ~6 tests (yaml + chained, 3 step types each).
2. **Silent-fail detection on chained runner** — ~5 tests (parens placeholder, agent-skip, list-tool antipattern, JSON-err, real-zero negative).
3. **registrySnapshot delta correctness** — ~4 tests (delta=Δ keys only, full final snapshot, multi-step delta merge, dashboard re-derive).
4. **`runlogVersion: 2` round-trip** — ~3 tests (read v1, read v2, mixed file).
5. **`replayRun` continuing to work** — ~2 tests (chained with v2, yaml with v2 — currently rejected, should still reject or unlock).
6. **JSON-prompt synthesis (B-PR3) round-trip** — **NOT IN B-PR1 SCOPE**. Belongs to B-PR3.

**Realistic test count for B-PR1**: 20+ tests across 4 new test files + 2 extended existing files. **~600-700 test LOC**. PLAN-B:118 lists 3 new test files. Plan undercounts by ~half.

If B-PR1 is split per §4.2:
- B-PR1a: tests 1, 2, 5 = ~13 tests, ~400 test LOC.
- B-PR1b: tests 3, 4 = ~7 tests, ~250 test LOC.

Each PR's test budget is realistic.

**Test category #6 (JSON-prompt round-trip) was a task-spec assertion but doesn't belong in B-PR1**. Plan-B correctly puts JSON-prompt lowering in B-PR3 (PLAN-B:163-202). Plan is correct here; the task-spec asked for an unwarranted test.

---

## 7. Hidden-assumption audit ("should work" / "for free" / "drop-in")

Every "should work" / "for free" / "drop-in" claim, with verification status:

| Plan claim | Cite | Verified? |
|---|---|---|
| "lint/schema/`recordRecipeRun`/VD-2/silent-fail apply for free" (post-B3) | PLAN-MASTER:55 | **Partially**. Lint + schema + recordRecipeRun apply free if synthetic recipe is well-formed. VD-2 + silent-fail apply free **only if B-PR1 has landed** — explicitly noted in PLAN-B:312. **Master claim "for free" understates the dep.** |
| "`replayRun` already only reads `step.output` and `step.status`, so it works against either runner once both produce VD-2" | PLAN-B:87 | Plausible but **not regression-tested in B-PR1's scope** per PLAN-B:118. Claim is "incidental improvement worth noting" (PLAN-B:331), so it's labeled-as-aspirational. OK. |
| "Older rows pre-dating B1 round-trip unchanged" | PLAN-B:333 | Plausible if every new field is optional. **Verify via test** (test category 4 in §6). Plan only lists "1 test" for round-trip; reality needs 3+ (v1-only, v2-only, mixed-row file). |
| "rename(2) atomicity when src + dst are on the same filesystem" | PLAN-A:118 | True on POSIX. **`mkdirSync(recursive: true)` first** ensures dst dir exists; if user mounts `~/.patchwork/inbox/foo` on a different filesystem (uncommon but legal on Linux), EXDEV. Not pinned. Add to PR-3 description. |
| "Cycle detection already exists at `chainedRunner.ts:993-1009`; reuse the topological order" | PLAN-A:120 | **WRONG**. Cycle detection at chainedRunner exists for **intra-recipe DAG** cycles, not **inter-recipe call** cycles. Verified via `C-triggers.md:62-63`. PLAN-A's claim is materially incorrect. **I-e2e Seam #3 is therefore unaddressed**, contradicting PLAN-MASTER:112's claim. |
| "RecipeOrchestrator.fire (`src/recipes/RecipeOrchestrator.ts:84-87`) — yamlRunner already runs as a fire-and-detach when called through orchestrator. Confirmed safe." | PLAN-B:201 | "Confirmed safe" needs a test. Plan does not list one for this claim. Dispatcher behaviour is core to JSON-prompt response-shape contract. |
| "Plan picks 16 (mid). Picking 8 is safer but blocks legitimate fan-out recipes. Picking 32 risks fd exhaustion." | PLAN-A:244 | Reasonable. No verification needed for a default. |
| "Defaults to 4 in `src/recipes/yamlRunner.ts:1371`" + "Defaults to 3 in `src/recipes/yamlRunner.ts:1372`" | C-triggers.md:47-48 | Source-pinned and confirmed. OK. |
| "All bundled recipes write under `~/.patchwork/inbox/` or `~/.patchwork/cache/`" | PLAN-A:59 | Verified by Plan-A's own grep. OK. |
| "Schema is additive" (post-B1) | PLAN-B:333 | True if every new field is `?` optional. Verify in `runLog.ts` change. |
| "B4 shippable without B3 but the test scenarios are simpler post-B3" | PLAN-B:312-313 | OK; Plan acknowledges weakness. |
| "Property test catches edge cases" (camelCase aliases) | PLAN-C:591 | Property test must include collision case (id + camelCase id both registered). Plan does not list this. |
| "Older runs in the log do not carry step detail" (dashboard graceful degrade) | E-tests-dashboard.md:163 | Confirmed live in dashboard. OK. |

**Net hidden-assumption issues**:
1. **PLAN-A:120 is materially wrong** about cycle detection. I-e2e Seam #3 (inter-recipe call cycles) is not addressed; Master's claim that C-PR3 covers it is also unsubstantiated in PLAN-C.
2. **B-PR1 backwards-compat tests are under-budgeted** — plan lists 1 round-trip test, reality needs 3+.
3. **"For free" claims understate B-PR1 dep** for B-PR3.

---

## 8. Final verdict

**Verdict: amend-and-ship.**

Phase 1 (week 1) and Phase 2 (week 2) are correctly identified as bleed-stoppers but Phase 1 alone does not stop F-03. The plan's core architecture (extract `stepObservation.ts`, eliminate JSON-prompt runner, single canonical resolver) is **sound and the right design**. The biggest weakness is **claim-without-anchor**: PLAN-MASTER lists round-2 I-e2e seams as covered by C-PR3 but C-PR3's actual scope in PLAN-C does not include them. This is a paper-coverage gap that will surface as "we shipped C-PR3 and Seam #3/4/5/6 are still broken."

**5 most important amendments before Phase 1 ships**:

1. **Promote A-PR4 (permissions decision) to Phase 1.** It is independent and small (~50 LOC if Option B). Phase 1 cannot honestly "stop the bleed" without closing F-03 — the sidecar files are public-facing decoration that operators trust today.

2. **Pin I-e2e Seams #3, #4, #5, #6, #9 to actual files in PLAN-C C-PR3 (or split out a C-PR3b).**
   - Seam #3 (inter-recipe call cycle detection) — needs a name-stack tracker in `loadNestedRecipe` or `chainedRunner`. Plan-A:120's claim that it's "already exists" is wrong.
   - Seam #4 (cron post-startup install) — needs `RecipeScheduler.reload()` method called from `installer.ts` or via a file-watcher.
   - Seam #5 (duplicate `name:` conflict) — needs install-time uniqueness check OR runtime conflict-error.
   - Seam #6 (multi-yaml package) — needs `installRecipeFromFile` (or equivalent) to register every YAML in dir, not just one.
   - Seam #9 (nested child runs absent from `/runs`) — needs `recordRecipeRun()` for nested calls.

3. **Split B-PR1 into B-PR1a (post-step pipeline) + B-PR1b (registrySnapshot delta + runlog v2 + dashboard reader).** B-PR1 as planned is the largest PR in the queue and crosses the bridge/dashboard boundary; splitting reduces blast radius.

4. **Add an explicit "unknown body keys" rejector to PLAN-A PR-1 OR a new PR.** H-routes Bug 3 (`args:` silently dropped) is currently un-pinned. Without it, third-party API consumers continue to lose data silently.

5. **Add F-tools F6/F7/F8 to a connector-hygiene PR** (could be PR-D or fold into B-PR1's `observeStep`). The silent-fail bypass on `linear.createIssue` bare `{error}` envelope and `gmail.getMessage` scalar errors is a known shape that B-PR1's `detectSilentFail` wiring will not catch — the detector requires `count`/`items`/`results` plus `error`. Either generalize the detector OR canonicalize the error-envelope shape in connectors. PLAN-MASTER:147-148 explicitly out-of-scopes the 7 connector files but does not flag F6/F7/F8 as still-uncovered after B-PR1.

**Smaller amendments worth doing**:

- Confirm `$result` is a real runtime root before whitelisting it in C1 lint (DP-5).
- Update PLAN-MASTER:71-93 dep graph to remove the 4 false-arrows (A-PR1/A-PR2 → B-PR1; B-PR1 → A-PR3+B-PR2; B-PR1 → B-PR4+C-PR4; B-PR1 → C-PR3-as-correctness-dep).
- Split C-PR2 into 3 PRs (enumeration parity / scaffold UX / log hygiene).
- Add bridge-wide concurrency cap note to A-PR3 description (DP-3 sub-issue).
- Drop `POST /recipes/:name/permissions` from C-PR4's land-set if DP-1 = Option B (DP-7 inconsistency).
- Verify B-PR1's `runlogVersion: 2` round-trip with 3+ tests, not 1 (§6 + §7).
- Add B-cli #31 (`recipe run --dry-run` exits 0 on lint errors) to C-PR2 scope (round-1 dropped finding).

**What the plan got right** (no changes needed):
- Single `stepObservation.ts` post-step pipeline as the unifying primitive (PLAN-B §5a).
- Eliminating the JSON-prompt third runner via synthetic-YAML lowering (PLAN-B PR-3).
- Canonical `resolveRecipe.ts` resolver with YAML-wins (PLAN-B PR-4).
- Camelcase auto-emit in `registerTool` (PLAN-C C-PR5).
- `parser.ts` deletion (PLAN-C C-PR1).
- 5-root reserved whitelist for lint (modulo `$result` verify).
- `*.permissions.json` Option B as default with Option A as fast-follow.
- Test-with-fix policy (no test-only PR).

**What the plan got wrong** (changes needed, ranked by severity):
- Claiming Phase 1 stops the bleed when F-03 lives in Phase 2 (HIGH).
- Plan-A:120 inter-recipe cycle detection misclassification (HIGH).
- Master claiming C-PR3 covers I-e2e #3/#4/#5/#6 with no PLAN-C anchor (HIGH — silent paper coverage).
- B-PR1 size + dashboard reader compat under-budgeted (MEDIUM).
- F-tools F6/F7/F8 silent-fail bypass not addressed (MEDIUM).
- H-routes Bug 3 unknown-key body validation not addressed (MEDIUM).
- C-PR2 7-bugs-in-1 over-bundling (LOW — review burden, not correctness).
- Decision-graph 4 false dep arrows (LOW — sequencing flexibility, not correctness).

If the maintainer ships the plan as-is, Phase 1 will close traversal/SSRF but the dashboard will still display permission badges that mean nothing; Phase 6 will land C-PR3 but I-e2e seams #3/#4/#5/#6 will resurface in the next dogfood cycle as "already-known-but-not-actually-fixed." With the 5 amendments above the plan ships clean.
