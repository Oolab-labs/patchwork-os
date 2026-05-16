# Dogfood Findings — 2026-04-29

> **Amendment (post-review):** CRIT-A and HIGH-A below are **false alarms** caused by my testing methodology. I navigated to `/inbox` etc. by typing URLs directly into the address bar; that bypasses Next.js's `basePath` rewriting (configured at `dashboard/next.config.js:2`). When the same routes are reached via the sidebar `<Link>` component, Next.js auto-prepends `/dashboard/` and they resolve correctly. Verified: clicking the Inbox sidebar link goes to `/dashboard/inbox` and renders 12 messages. **The sidebar nav works.** The fix plan at [plans/dashboard-fix-plan.md](plans/dashboard-fix-plan.md) v2 has the corrections. Other findings below stand.

**Method:** Parallel agents — Playwright walked every dashboard page; a CLI dogfood agent ran the recipe install/enable/disable/run/uninstall lifecycle against the running bridge (port 3101).

**Setup observed:** Bridge `0.2.0-alpha.35` running on :3101, dashboard dev server on :3200, MCP session active. Globally-installed `patchwork` CLI **lags behind main** — does not include PR #52 (`recipe uninstall`) or the latest recipeInstall.ts work, so some CLI surprises here are "stale install" artifacts rather than real source bugs.

---

## CRITICAL — ship-stoppers

### CRIT-A · Sidebar nav links don't include the `/dashboard/` prefix
**Where:** every page; sidebar `<a>` tags point at `/inbox`, `/approvals`, `/recipes` etc., but the app is mounted at `/dashboard/*`.
**Effect:** **Every menu click 404s.** A first-time user can't navigate the dashboard at all without manually editing the URL bar.
**Repro:** load `localhost:3200`, click any sidebar item.
**Fix:** prefix all sidebar `Link href` with `/dashboard`. Probably one component file.

### CRIT-B · `/dashboard/runs/<seq>` returns 404 for every seq
**Where:** Runs detail page.
**Effect:** Runs list shows 100 entries, but **#1 and #100 both 404** when clicked. The visual debugger surface (the very page the next planning doc targets) is currently inaccessible. List and detail are reading from different stores.
**Repro:** navigate to `/dashboard/runs`, click any row, observe `Failed to load run: 404`.
**Implication:** Phase 1 of the visual debugger plan should INCLUDE fixing this — replay/live-tail are pointless if the detail page can't load any run.

---

## HIGH — visible bugs / regressions

### HIGH-A · `/dashboard/inbox` 404
**Where:** Inbox page.
**Effect:** The folder `dashboard/src/app/inbox/` exists but no `page.tsx` rendered. Sidebar's "Inbox" link sends the user to a 404. Even with the prefix fix from CRIT-A, this would still 404.
**Fix:** restore `inbox/page.tsx` or remove the sidebar entry until ready.

### HIGH-B · `/dashboard/recipes/new` emits the broken `$schema` URL (PR #44 regression)
**Where:** the YAML preview pane on the form.
**Observed output:**
```yaml
# yaml-language-server: $schema=https://patchworkos.com/schema/recipe.v1.json
```
**Expected:** the working URL we standardized on:
```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json
```
**Effect:** PR #44 fixed the CLI template but the dashboard's `/recipes/new` form has its own copy of the template string. Editors fetching from the dashboard-generated header still hit a 401.
**Fix:** find the template in `dashboard/src/app/recipes/new/page.tsx` and replace.

### HIGH-C · Marketplace renders 6 empty card outlines
**Where:** `/dashboard/marketplace`.
**Effect:** Page shows six empty bordered rectangles with no content, no skeleton text, no error message. Looks broken / under-construction. If the registry is genuinely empty, the empty-state should say so explicitly.
**Fix:** detect zero-results case, show "No recipes yet — be the first to publish" or similar.

### HIGH-D · `/dashboard/connections` stuck on "Loading…"
**Where:** Connections page.
**Effect:** "Loading…" never resolves. **Footer flips to "Bridge offline"** on this page only — every other page shows "Connected:3101". An API call from this page is timing out or auth-failing in a way that toggles the connection-status indicator globally.
**Fix:** investigate the connector list endpoint specifically; surface a timeout error rather than spinning forever.

### HIGH-E · `recipe run <installed-name>` doesn't resolve install-dir recipes
**Where:** CLI.
**Effect:** After `recipe install /tmp/test-recipe-local && recipe enable test-recipe-local`, calling `recipe run test-recipe-local` errors with `Error: recipe "test-recipe-local" not found in /Users/wesh/.patchwork/recipes`. The lookup checks `<name>.yaml` directly under the recipes dir, not inside `<name>/<entrypoint>.yaml`.
**Repro:** above sequence.
**Fix:** the lookup needs the same install-dir traversal logic that PR #49 added to `findYamlRecipePath`. Likely a separate code path on the `recipe run` branch in `src/index.ts` (or wherever the CLI dispatches `run`) that hasn't been updated.

### HIGH-F · CLI subcommand exit races with bridge startup
**Where:** Globally-installed CLI (and likely dev tree too).
**Effect:** Subcommand IIFE branches like `recipe install` call `process.exit(0)` after their async work, but the index.ts file executes additional top-level code synchronously after the IIFE invocation — including bridge startup. When a subcommand's async work takes a few seconds (network), the bridge starts up alongside the failing subcommand:
```
Error: HTTP 404 fetching https://api.github.com/...
[bridge 2026-04-29T02:13:59.409Z]   Tools: full (~140 tools — IDE + git + ...) [default]
```
**Effect for users:** error messages get buried under bridge log spam; risk of unwanted bridge process running after a CLI command.
**Fix:** restructure `src/index.ts` so subcommand branches return early and the bridge startup is gated behind the absence of any matching subcommand. Or: convert to a proper CLI parser (commander/citty) with explicit dispatch.

---

## MEDIUM

### MED-A · Sessions shows "0 active" despite a connected MCP session
**Where:** `/dashboard/sessions`. Settings agrees ("Active sessions: 0").
**Effect:** I'm currently connected to the bridge via MCP — should appear here. Either the Sessions counter only tracks `claude code` ide-bridge sessions (excluding MCP clients) — in which case the page should say so — or the count is just wrong.

### MED-B · Stat counts disagree across pages
- Overview: "82 tool calls today"
- Activity: "100 events / 52 tool calls"
- Analytics: "77 total tool calls / Last 24h"
**Three different numbers in three places.** Probably different time windows (today vs. last hour vs. last 24h) but the labels don't make this clear.

### MED-C · `/dashboard/analytics` shows literal `"NaNs"` for p50/p95
**Effect:** The latency table shows `getDiagnostics` with `0` errors and **`P50: NaNs`, `P95: NaNs`** as the literal string. Should be an em-dash or "—" or a real percentile.

### MED-D · `recipe new <name>` writes to `~/.patchwork/recipes/` instead of cwd
**Where:** CLI.
**Effect:** Invoking `patchwork recipe new my-recipe` from `/tmp/` writes the file to `~/.patchwork/recipes/my-recipe.yaml`, not `/tmp/my-recipe.yaml`. Surprising — most scaffolders write to cwd by default. Either document this loudly in the success message, or accept a `--out` flag.

### MED-E · Multiple "duration in raw seconds" displays
- Overview: "1861m 38s" (acceptable but not ideal)
- Settings: "Uptime: 112219s" (raw seconds — 31 hours)
- Metrics: "bridge_uptime_seconds: 112,157" (also raw)
**Effect:** Mixed humanization across pages. Either consistently render as `Xd Xh Xm` everywhere, or show raw seconds + parenthesized human format.

### MED-F · `/dashboard/recipes` row overflow with long descriptions
**Where:** the `ctx-loop-test` description (~6 lines) overflows the row vertically and pushes neighboring rows out of alignment. Other rows then stretch to match.
**Fix:** clamp descriptions at 2 lines + "More" expand.

---

## LOW

- 4× console 404 on `/manifest.json` and `/favicon.ico` / `/favicon.svg` on every page load. Add files or remove `<link>` tags.
- "Good morning" greeting on Overview is hardcoded — doesn't adapt to time of day.
- Recipes list shows two `daily-status` recipes (different triggers, same name). Display ambiguity even though they're in different install dirs.
- Top horizontal nav (Recipes/Marketplace/Tasks/Runs) appears alongside the sidebar — duplicates navigation. Pick one source of truth.

---

## Successful flows (no issues found)

- **Approvals page** — loads cleanly, "0 pending / All caught up" empty state is good.
- **Activity page** — SSE stream works, events render, filtering UI clean.
- **Tasks page** — 241 tasks load, output previews readable, filter chips work.
- **Traces page** — 64 traces render, grouping by kind works.
- **Decisions page** — 15 decisions render with kind groups + tag filter.
- **Settings page** — bridge config visible, AI provider switcher present.
- **Metrics page** — Prometheus counters render live, "57 series, 4 groups" looks healthy.
- **`recipe new`** — generated YAML has the **correct** `$schema` URL post-PR #44 (the dashboard form has the bug; CLI is fixed).
- **`recipe install` from local dir** — works, files copied to install dir, `.disabled` marker written.
- **`recipe enable/disable`** — both flows work, marker file appears/disappears correctly.

---

## Suggested PR sequence

| # | PR | Severity | Effort |
|---|---|---|---|
| 1 | Fix sidebar nav to use `/dashboard/*` prefix (CRIT-A) | CRIT | S |
| 2 | Fix `/dashboard/runs/<seq>` data store mismatch (CRIT-B) | CRIT | M |
| 3 | Fix `/dashboard/recipes/new` `$schema` URL (HIGH-B, PR #44 follow-up) | HIGH | S |
| 4 | Add `/dashboard/inbox/page.tsx` or remove sidebar entry (HIGH-A) | HIGH | S |
| 5 | Marketplace empty state messaging (HIGH-C) | HIGH | S |
| 6 | `recipe run <name>` traverses install dirs (HIGH-E, parity with PR #49) | HIGH | M |
| 7 | CLI subcommand / bridge-startup race (HIGH-F) | HIGH | M |
| 8 | Connections page stuck loading (HIGH-D) | HIGH | M |
| 9+ | MEDs in one cleanup pass | MED | S each |

PRs 1–3 are 5-minute fixes that would substantially de-broken the user's first experience. The first three should bundle into one "first-impression" PR.

---

## Notes for the visual-debugger plan

The [docs/plans/visual-recipe-debugger.md](plans/visual-recipe-debugger.md) plan assumed `/dashboard/runs/<seq>` was a working baseline. **It's not** — the page 404s for every seq right now. Phase 0 of that plan should be "fix run-detail data path" before any debugger feature work begins. Likely the same `findInstallDirByRecipeName`/`iterateInstallDirs` work from PR #49 needs to apply to the run-detail lookup, or the run-log query is mis-keyed.
