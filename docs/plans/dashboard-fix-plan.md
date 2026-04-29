# Dashboard + Recipe Lifecycle Fix Plan (v2.1 — post-final-pass)

**Status:** Plan, reviewed twice
**Origin:** [docs/dogfood-findings-2026-04-29.md](../dogfood-findings-2026-04-29.md) — Playwright + CLI dogfood pass
**Reviewers:** ide-code-reviewer (technical) + general-purpose (structural) + final-pass executable-readiness check.

> **v2.1 corrections from final pass — read before executing PR #2 / #4 / #5:**
>
> - **PR #2 — add a step 0**: `ps aux | grep next` to determine whether the dashboard is running `next dev` (`dashboard/package.json:7`) or `next start`. If `next dev`, the stale-build hypothesis is structurally impossible — skip rebuild and go straight to hypothesis 2 (lock-file lookup).
> - **PR #4 — fix target deeper than v2 said**: `findYamlRecipePath` (`src/recipesHttp.ts:859`) is itself flat-file only — does NOT descend into install subdirectories. Both call sites (`commands/recipe.ts:1090` for CLI fallback + `recipeOrchestration.ts:231` for the bridge-side runner) need to call `findInstallDirByRecipeName` or equivalent BEFORE the flat-file candidates. v2's "swap to `findYamlRecipePath`" is insufficient.
> - **PR #5 — sentinel is solving a non-bug**: the existing code at `src/index.ts:2677-2729` already gates `bridge.start()` on subcommand IIFEs that all `process.exit`. A sync throw bubbles through the unhandled-rejection handler at `:2257` which itself calls `process.exit(1)`. The real risk is IIFEs that `return` without `process.exit` — scan for those and fix directly. No sentinel needed.
> - **PR #1 / PR #7** confirmed ready to execute as-is.
>
> Companion artifact: [docs/plans/punch-list.md](punch-list.md) — unified backlog across all today's plans (DB-1..7, VD-1..4, W2-A0..A5, AI-1, IMM-1, SS-1).

---

## Reviewer corrections folded in

| Plan v1 claim | Reality | Fix |
|---|---|---|
| **CRIT-A: sidebar nav 404s every link** | **WRONG.** `dashboard/next.config.js:2` sets `basePath: "/dashboard"`. Next.js's `<Link>` auto-prepends. Verified: clicking sidebar Inbox link resolves to `/dashboard/inbox` and renders 12 messages correctly. The "404" I saw came from typing `localhost:3200/inbox` *directly* in the address bar, which bypasses basePath. | **Drop CRIT-A entirely.** Sidebar nav works. The dogfood findings doc must be amended too. |
| HIGH-A: `/dashboard/inbox` 404 | False — page renders fine when reached via the sidebar Link. | Drop HIGH-A. |
| PR #1 fix: prefix `<Link>` hrefs with `/dashboard/` | Would produce `/dashboard/dashboard/inbox` — double-prefix 404s. Don't apply. | Don't change Shell.tsx hrefs. |
| PR #2 hypothesis 2 (Next 14 vs 15 params shape) | Already moot — confirmed Next 14.2 sync params is correct. | Drop hypothesis. |
| PR #2 hypothesis 4 (token cache) | `findBridge()` reads lock fresh every call (`bridge.ts:111`), no caching. | Drop hypothesis. |
| PR #4: `recipe run` has its own inline lookup | Imprecise — `runRecipe` (`commands/recipe.js`) already uses `findYamlRecipePath`. The bug if it exists is in the bridge-side `/recipes/run` handler, not the CLI lookup. | Re-scope PR #4 to verify bridge handler first, then fix appropriately. |
| `$schema` regression only in `recipes/new/page.tsx:110` | Also stale URL in `templates/recipes/project-health-check.yaml:1`. | Add to PR #1 scope. |

---

## TL;DR (v2)

**Real bugs to fix, ranked:**

1. **`/api/bridge/*` proxy returns Next.js 404 for every endpoint** (CRIT) — was CRIT-B; remains the most impactful issue. Affects run-detail, connections, plus everything else that calls the bridge through the dashboard.
2. **`/dashboard/recipes/new` `$schema` URL regression** (HIGH) — PR #44 follow-up.
3. **Run-detail seq <(latest-500) returns 404** (HIGH) — RecipeRunLog ring buffer cap drops older seqs even though they're on disk.
4. **`recipe run <name>` not finding install-dir recipes** (HIGH) — needs verification of bridge-side `/recipes/run` handler.
5. **CLI / bridge-startup race** (HIGH, was MED in v1) — `src/index.ts` is the entry point; mis-fix breaks everything.
6. **Marketplace empty cards, NaNs in p50/p95, raw seconds, row overflow** (HIGH/MED render bugs).
7. **Sessions 0 active, stat-count disagreement, `recipe new` cwd surprise** (MED data semantics).

**Estimated total: 1.5–2 days across 6 PRs.**

---

## PR #1 — `$schema` URL + manifest 404s (was "first impressions")

**Effort:** 30 min · **Risk:** Low

Drops the sidebar-prefix change (it was wrong). Remaining work:

1. **`dashboard/src/app/recipes/new/page.tsx:110`** — replace `https://patchworkos.com/schema/recipe.v1.json` with `https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json`. Same swap as PR #44 did on the CLI side.
2. **`templates/recipes/project-health-check.yaml:1`** — same URL swap (this template was missed in PR #44 too).
3. **Console 404s** on `/manifest.json`, `/favicon.ico`, `/favicon.svg` — add stub files under `dashboard/public/` matching the `<link>` paths in `dashboard/src/app/layout.tsx`. Or remove the `<link>` tags.
4. **`dashboard/public/schema/recipe.v1.json`** still has `$id` referencing `patchworkos.com` per the reviewer. Regenerate or replace.

### Test plan

- Generate recipe via `/dashboard/recipes/new`, copy YAML → `curl` the `$schema` URL → 200.
- Console clean of 404s on home page reload.
- `grep -r "patchworkos.com" dashboard/ templates/` returns 0 hits.

---

## PR #2 — `/api/bridge/*` proxy diagnosis + fix

**Effort:** 1h–full day depending on root cause · **Risk:** Medium-High

### What's broken (verified)

```
$ curl http://localhost:3200/api/bridge/runs
HTTP/1.1 404 Not Found  ← Next.js 404 HTML, not bridge response
$ curl http://localhost:3101/runs -H "Authorization: Bearer $token"
200 OK + JSON  ← bridge serves correctly
```

Even known-good endpoints return Next.js 404 HTML. Yet other dashboard pages successfully fetch (Recipes shows 15, Activity streams events). Probably means the proxy was working at page-render time but breaks for runtime fetches — most likely **stale `.next` build** running against newer source code.

### Hypothesis order (cheapest first)

1. **Stale build** — `cd dashboard && npm run build && pkill -f "next start" && npm start`. If this fixes it, the bug is "we shipped without rebuilding the dashboard." Add a `dev` script that warns when `.next/BUILD_ID` is older than `src/app/api/`.
2. **Lock-file lookup misses bridge** — `findBridge()` (`dashboard/src/lib/bridge.ts:37`) might find a stale lock or none. Reviewer verified the code is correct; only worth investigating if hypothesis 1 fails.
3. **Process-port mismatch** — verify the dashboard process is actually on 3200 and routes are registered: `curl localhost:3200/api/bridge/_test` (will 404 with bridge JSON if proxy is alive, with HTML if not).

Reviewer dropped hypotheses 2 (Next 14 vs 15) and 4 (token cache) — both moot.

### Bonus payoff

Fixes simultaneously: `/dashboard/runs/<seq>`, `/dashboard/connections` stuck-loading, the "Bridge offline" footer flicker.

### Test plan

- `curl http://localhost:3200/api/bridge/runs` → 200 + JSON
- `curl http://localhost:3200/api/bridge/runs/<latest-seq>` → 200 + JSON
- `/dashboard/runs/<latest>` loads with full step timeline
- Connections page resolves to a real connector list

---

## PR #3 — Run-detail seq range (independent of PR #2)

**Effort:** 2h · **Risk:** Low · **Decoupled from PR #2** per structural review

### What's broken (verified)

`runs.jsonl` has 1133 entries spanning seq 1–2801. `RecipeRunLog` (`src/runLog.ts:65`) has `DEFAULT_MEMORY_CAP = 500`. `getBySeq` calls `syncFromDisk` first but that only catches *new* lines (`seq > this.seq`, `runLog.ts:237`), not older ones evicted from memory. Result: any seq older than the last 500 returns 404 even though it's on disk.

### Fix

Read-on-miss: when `getBySeq(seq)` doesn't find the entry in memory, scan `runs.jsonl` once for that seq (~5KB read).

### Test plan

- Vitest: append fake runs older than the cap, query — returns the run.
- In-memory hits stay O(1).

---

## PR #4 — `recipe run` install-dir resolution (re-scoped per code review)

**Effort:** 1–4h · **Risk:** Medium

### What's broken (verified by reproduction)

CLI: `recipe install /tmp/test-recipe-local && recipe enable test-recipe-local && recipe run test-recipe-local` → `Error: recipe "test-recipe-local" not found in /Users/wesh/.patchwork/recipes`.

### Re-scoped per code reviewer

The reviewer pointed out my earlier diagnosis was imprecise. The `recipe run` CLI dispatch in `src/index.ts:866` calls `runRecipe` from `commands/recipe.ts`, which DOES already use `findYamlRecipePath` (post-PR #49 — install-dir aware). So the bug is most likely in:

1. The **bridge-side `/recipes/run` handler** — does its lookup go through `findYamlRecipePath` or its own path?
2. Or the **handoff between CLI and bridge** when both are running — the dispatch might prefer the bridge path and the bridge has a different lookup.

### Investigation step (before code change)

- Read `src/server.ts` for `/recipes/run` route handler. Check what lookup it uses.
- Read `src/recipeOrchestration.ts` `runRecipeFn`. Same.
- Reproduce: with bridge running, does `recipe run` go local or via bridge? Inspect from log lines.

Then fix the actually-broken handler (probably one-liner to swap to `findYamlRecipePath`).

### Test plan

- `recipe install /tmp/x && recipe run x` → succeeds whether bridge running or not.
- Top-level legacy YAML still works (regression check).

---

## PR #5 — CLI / bridge-startup race (was PR #5; **promoted before PR #4**)

**Effort:** 2–4h · **Risk:** **High** (was Medium — `src/index.ts` is the entry point)

### What's broken (verified by code review)

`src/index.ts:2677` end-of-file: bridge.start() runs unconditionally. The subcommand `if`-blocks above (recipe run/install/etc.) spawn IIFEs but don't gate the boot. On slow IIFE work the bridge boots alongside the failing subcommand.

### Why PR #5 ships **before** PR #4

Both touch `src/index.ts`'s subcommand dispatch ladder. Land #5's restructure first to avoid two competing rewrites of the same code.

### Fix (sentinel option — surgical)

```ts
let consumedSubcommand = false;
// ...inside each subcommand IIFE branch, first line:
consumedSubcommand = true;
// ...end of file, before bridge.start():
if (consumedSubcommand) {
  // nothing; subcommand IIFE will exit when its async work finishes
} else {
  await bridge.start();
}
```

### Tests (mandatory given High risk on entry-point code)

- Vitest: each subcommand sets the sentinel before any async work.
- Smoke: `node dist/index.js` (no args) starts bridge.
- Smoke: `node dist/index.js recipe install <bad>` exits 1, no bridge log noise.
- Smoke: `node dist/index.js recipe install <good>` exits 0, no bridge log noise.

---

## PR #6a — Render bugs (split per structural review)

**Effort:** 1h · **Risk:** Low

- `/dashboard/marketplace` — replace empty card outlines with "No recipes yet" empty state.
- `/dashboard/analytics` — coalesce `NaN` to `"—"` in p50/p95 cells.
- `/dashboard/recipes` — clamp long descriptions to 2 lines (`-webkit-line-clamp: 2`).

---

## PR #6b — Data semantics (was bundled in v1)

**Effort:** 2h · **Risk:** Medium (touches multiple stat aggregations)

- **Verify before labeling**: stat counts (Overview 82, Activity 52, Analytics 77) — confirm they really are different time windows before adding labels. If they're using different stores, that's a deeper aggregation bug.
- Add explicit time-window labels to each stat card.
- New `dashboard/src/lib/format.ts` with `formatDuration(seconds) → "1d 7h 12m"`. Use across Overview / Settings / Metrics.
- Sessions counter: scope to "Active Claude Code sessions" or include MCP sessions. Pick one and label clearly.
- `recipe new <name>` — accept `--out` flag or document the `~/.patchwork/recipes/` write loudly in the success message (added per structural review's MED-D callout).

### Test plan

- Verify Overview / Activity / Analytics counts come from the same store with different windows.
- `formatDuration(3661)` → `"1h 1m 1s"`.
- `recipe new test --out /tmp` writes `/tmp/test.yaml`.

---

## PR #7 — Regression test infrastructure (added per structural review)

**Effort:** 3h · **Risk:** Low

Reviewer flagged that every "Test plan" in the v1 plan was manual. Add automated coverage so these specific bugs can't regress:

1. **Playwright E2E** in `dashboard/tests/e2e/sidebar.spec.ts`: walks every nav item, asserts response 200 + page title contains expected text. Would have caught the inbox false-alarm + any future new-page-not-wired-up bug.
2. **Bridge proxy smoke test** in CI: after `next build`, run `curl /api/bridge/runs` → expect 200 + JSON. Would have caught CRIT-B.
3. **`getBySeq` read-on-miss test** — already mandated in PR #3.
4. **`recipe run` install-dir test** — already mandated in PR #4.

---

## Suggested merge order (revised)

| Order | PR | Reason |
|---|---|---|
| 1 | #1 `$schema` URL + manifest 404s | 30 min, no risk, ships today |
| 2 | #3 RecipeRunLog read-on-miss | Independent of #2 (per structural review), can land in parallel |
| 3 | #2 Proxy diagnosis + fix | Unlocks Connections, Runs detail, visual-debugger |
| 4 | #5 CLI / bridge race | Before #4 — same-file collision (per structural review) |
| 5 | #4 `recipe run` install-dir | After #5 |
| 6 | #6a Render bugs | Polish |
| 7 | #6b Data semantics | Polish |
| 8 | #7 Regression tests | Wrap-up |

---

## Visual-debugger plan addendum (reframed per structural review)

Don't fold into this plan. Add a one-line *prerequisite* note to [docs/plans/visual-recipe-debugger.md](visual-recipe-debugger.md):

> **Prerequisite:** `/dashboard/runs/<seq>` must load. Today it 404s due to two issues being fixed in [docs/plans/dashboard-fix-plan.md](dashboard-fix-plan.md) PR #2 (proxy) + PR #3 (older-seq read). Visual debugger Phase 1 work assumes those have shipped.

---

## What changed from v1

- Dropped CRIT-A and HIGH-A entirely — false alarms from typing URLs instead of clicking Links.
- Dropped PR #2 hypotheses 2 and 4 (already verified moot).
- Decoupled PR #3 from PR #2 (independent fixes).
- Reordered PR #5 before PR #4 (same-file collision).
- Split PR #6 into 6a (render) and 6b (data).
- Bumped PR #5 risk to High.
- Added MED-D (`recipe new` cwd) to PR #6b.
- Added templates/recipes URL fix to PR #1.
- Added new PR #7 for regression test infra (Playwright sidebar walk + bridge proxy smoke).
- Reframed visual-debugger handoff as a prerequisite note, not a phase merge.

---

## Bottom line

**Ship as v2.** Reviewers caught a real correctness bug in v1 (CRIT-A diagnosis was wrong) and several structural improvements. v2 incorporates all 10 of the structural-reviewer's edits + the technical-reviewer's findings. The diagnosis is now sound; the sequencing is now correct. Start with PR #1 — 30 min, ship today.
