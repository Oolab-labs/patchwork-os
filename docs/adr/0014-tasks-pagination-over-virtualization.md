# ADR-0014: /tasks pagination over virtualization

**Status:** Accepted
**Date:** 2026-05-19

## Context

The 2026-05-19 dashboard-quality audit flagged `/tasks` as a perf risk: the page renders a full list of background Claude task records, which on a busy workspace can reach 500+ rows. Rendering the whole filtered list reconciles 500 button rows on every poll tick, with each row carrying a status pill, driver badge, clamped output line, duration, and a click handler.

The audit's recommendation was to virtualize the list with `@tanstack/react-virtual`. We shipped a cheaper intermediate fix instead (PR #703): cap rendered rows at 100 by default, add a "Show {n} more" affordance that reveals the next 200, reset the window on filter/search change, and rescope `j`/`k` keyboard nav to the rendered slice (pressing `j` past the last visible row auto-reveals more).

After shipping the cap, we re-audited whether virtualization was still worth doing.

## Decision

Stop here. The cap-at-100 + Show-more pattern is fit-for-purpose for an internal dashboard. We are **not** virtualizing `/tasks` at this time.

## Why this is the right cut

1. **Filter UI is the intended navigation.** `/tasks` has status filters (live / done / error) and a free-text search. The expected interaction is "filter to the slice you care about," not "scroll through 500 rows linearly." Once filtered, the result set rarely exceeds 100.
2. **The cap solves the actual perf problem.** Reconcile cost is roughly linear in rendered rows. 100 rows × 5 poll/min × 3 children/row = ~25 DOM updates/sec at worst. That's well under the threshold where users notice.
3. **Virtualization has real refactor cost.** [`dashboard/src/app/globals.css`](../../dashboard/src/app/globals.css) sets `.app-main` to `overflow-y: visible` deliberately (single-scroll design; the right detail pane uses `position: sticky`). Virtualizing forces either `useWindowVirtualizer` with a left-column ref for scroll-margin math, or introducing a new scroll container that breaks the sticky pane. Both options are real work.
4. **`j`/`k` would need a measurement-aware rewrite.** With virtualization, off-screen rows aren't in the DOM, so `scrollIntoView` on the `data-task-row` selector doesn't find them. The fix is `virtualizer.scrollToIndex(idx)` + an `rAF` to wait for the row to mount, then focus. Doable, but more state to debug.
5. **Marginal user benefit.** "Show more" + filter is a known, familiar pattern. No measured complaints about the current behavior on either desktop or mobile.

## Alternatives considered

1. **Virtualize behind a length gate (`filteredTasks.length > 200`).** Lower-risk than full virtualization but still imports a dependency and adds a code path that's exercised only by power users. The dep is ~5 KB gzipped, but more importantly we'd own a second render path forever.
2. **`react-window` instead of `@tanstack/react-virtual`.** Smaller, but worse at variable-height rows with wrapping text. Bad fit for `/tasks` (output line wraps).
3. **Server-side pagination.** Would mean a real `?offset=` / `?limit=` API contract from the bridge. None exists today. Overkill for the row counts involved.

## When to revisit

Reopen this decision if any of the following happen:

- A measured scroll-jank complaint on `/tasks` from a real user, ideally with a perf trace.
- `/tasks` regularly exceeds 1k rows in a single filtered view (current p99 is ~500).
- We need the same virtualization pattern for `/runs` or `/activity` and the shared component is worth the dep.

## Consequences

- The "Show more" button is the entry point for power users who need older tasks. Filtering remains the recommended path.
- `j`/`k` continues to operate on the rendered window. This is documented in the keyboard-shortcut overlay (when that lands).
- No new dependency on `@tanstack/react-virtual`. Dashboard bundle stays smaller by ~5 KB gzipped.
- The audit recommendation is closed out, not deferred. If a user complaint surfaces we open a fresh issue and re-evaluate against the trigger conditions above.

## References

- PR #703 — `/tasks` cap-at-100 + Show-more
- 2026-05-19 dashboard-quality audit synthesis
- [`dashboard/src/app/tasks/page.tsx`](../../dashboard/src/app/tasks/page.tsx) — `ROW_PAGE` constant + Show-more affordance
