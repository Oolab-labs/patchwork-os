# Dashboard Gap Assessment — 2026-07-03

Method: three parallel read-only scans — (1) full bridge HTTP route inventory (165+ endpoints
across server.ts / recipeRoutes.ts / approvalHttp.ts / connectorRoutes.ts / inboxRoutes.ts /
oauthRoutes.ts / mcpRoutes.ts / streamableHttp.ts), (2) dashboard consumer inventory
(37 unique bridge paths consumed across pages/components/hooks), (3) targeted lifecycle/honesty
audit with file:line evidence. Conflicts resolved in favor of specific line evidence.

## A. Endpoint orphans — bridge features with no dashboard surface

Operator-relevant endpoints with **zero dashboard consumers**:

| Endpoint | What it holds | Why it matters |
|---|---|---|
| `GET /gate/decisions` (recipeRoutes.ts:986) | The Decision Record — per-worker × action-class gate decisions | **The headline "receipts" feature is still invisible in the product.** Roadmap #5 flagged this 2026-07-02; unchanged. |
| `GET /runs/judge-summary` (recipeRoutes.ts:938) | Judge-step verdicts across runs | CLI-only (`patchwork judgments`). No dashboard view of what judges approved/rejected. |
| `GET /activation-metrics` (recipeRoutes.ts:872) | Activation/funnel metrics | Computed, never shown anywhere. |
| `GET /approval-insights/replay` (server.ts:1546) | Replay historical approvals vs a policy | No UI for "what would this policy have done" (roadmap #15). |
| `POST /runs/{id}/cancel` (recipeRoutes.ts:1391) | Cancel a running run | **Dashboard can retry a run but cannot stop one.** Live page shows a running run with no stop control; only tasks have cancel. |
| `POST /recipes/{name}/promote` (recipeRoutes.ts:2129) | Promote a recipe variant | Variant workflow has no UI ending. |
| `POST /recipes/{name}/duplicate` (recipeRoutes.ts:2102) | Duplicate recipe | No "duplicate" affordance on recipe pages. |
| `POST /recipes/{name}/trust` (recipeRoutes.ts:1754) | Set recipe trust level | Trust is settable over HTTP but not from the UI. |
| `GET /webhook-payloads/{path}` (server.ts:1472) | Recent webhook payloads | Debugging webhook recipes requires curl; a payload viewer on the recipe page would close it. |

~~Verify-then-decide~~ **RESOLVED 2026-07-03 — all four are false-orphans, confirmed consumed.**
The original scan missed these because the dashboard hits them through `/api/bridge/*` or a
dedicated `/api/*` proxy route rather than the bridge path literally, and via components/hooks
rather than page-level fetches:
- `GET /approval-insights` (base) — `dashboard/src/app/insights/page.tsx:166` fetches
  `/api/bridge/approval-insights`; `insights/replay/page.tsx:66` hits the `/replay` sub-route too.
- `GET /analytics` — `dashboard/src/app/analytics/page.tsx:105` fetches
  `/api/bridge/analytics?windowHours=`.
- `GET /inbox` + `/inbox/{file}` — `dashboard/src/app/inbox/page.tsx:321,351,408`,
  `dashboard/src/app/today/page.tsx:240,273`, `dashboard/src/app/page.tsx:279,468` (terminal
  deck, PR #1095), and `dashboard/src/components/CommandPalette.tsx:176` all fetch
  `/api/inbox`/`/api/inbox/{name}` (a dedicated Next.js route proxying the bridge path, chosen
  specifically so inbox reads still work when the bridge is offline — see the CommandPalette
  comment at line 175).
- `GET /stream` — the busiest of the four. Shared singleton at
  `dashboard/src/lib/streamLiveness.ts:51` (`new EventSource(apiPath("/api/bridge/stream"))`),
  consumed via `subscribeStreamMessage`/`subscribeStreamLiveness` by `Shell.tsx`,
  `useBridgeStatus.ts`, `LiveRunsContext.tsx`, `settings/page.tsx`, `activity/page.tsx`. A
  second layer, `dashboard/src/hooks/useBridgeStream.ts`, wraps the same shared path for
  `ActivityTicker.tsx`, `runs/page.tsx`, `runs/[seq]/page.tsx`, `useApprovalPatterns.ts`,
  `useRecipeRunStream.ts`. (Approvals has its own separate `/approvals/stream` SSE endpoint —
  distinct from `/stream`, also consumed, at `approvals/page.tsx:708`.)

No UI work needed for any of these per the task's original instruction — verification only.

Consumed-but-worth-noting: `/workers/shadow` and `/outcomes/pending` ARE polled by /workers
(workers/page.tsx:1152–1169) — the July 2 roadmap items #3/#4 partially landed.

## B. Lifecycle / honesty gaps (all confirmed with evidence)

1. **Staleness — GAP.** No page shows "as of" or detects a stopped poll. useBridgeFetch
   (hooks/useBridgeFetch.ts:64–127) keeps last-good data with no stale marker; overview
   (page.tsx:339), runs (runs/page.tsx:295), workers (workers/page.tsx:1152) all render
   frozen numbers indistinguishable from a quiet system. Same bug-shape as the synthetic-halt
   problem: the display can't distinguish "nothing happening" from "not being told."
2. **Token expiry — GAP.** `baseConnector.ts:26` stores `expiresAt` but it never crosses HTTP:
   connectorRoutes.ts `/connections` response and dashboard ConnectorStatus type
   (connections/types.ts) carry only `{id, status, lastSync}`. A token expiring tomorrow looks
   identical to one valid for a year. (This is the alt-desk "token expired Tuesday,
   silent-fail since" scenario as a product gap.)
3. **KPI visibility — PARTIAL.** Considered-approval stats render only inside a DetailsFold on
   /workers (workers/page.tsx:137–216), current-period only, no trend. **Evidence latency
   (worker filing → operator verdict) is computed nowhere** — filedAt and checkedAt both exist
   (lines 221–251) but the delta is never aggregated. The declared moat KPI is unmeasured.
4. **Recipe staleness — GAP.** `Recipe.lastRun` is fetched (page.tsx:69) and never checked:
   no "enabled cron that hasn't fired in N× cadence" warning anywhere. Broken cron ≡ quiet cron.
5. **Empty states — PARTIAL.** Rich (teach + action): /recipes, /runs, /approvals, /activity.
   Bare: /tasks, /inbox. /workers teaches the path but doesn't link templates/workers.
   EmptyState component supports action buttons — adoption is inconsistent, not capability.

## C. Ranked fixes

1. **Staleness indicator in useBridgeFetch** (S) — one hook change: track lastSuccessAt, expose
   `stale` after 3× poll interval; Shell renders a global "data as of HH:MM:SS — reconnecting"
   strip. Fixes every page at once. Honesty issue, and honesty is the brand.
2. **Token expiry through the pipe** (S) — add expiresAt + lastSuccessAt to connector getStatus()
   → /connections response → connections card ("expires in 6d" amber under 7d) + a morning-brief
   line. Directly prevents the most common silent-failure class in the field.
3. **Decision Record drawer** (M) — first consumer for /gate/decisions (roadmap #5): drawer on
   /workers rows + recent-gate-activity feed. The product finally shows its receipts.
4. **Run cancel button** (S) — wire POST /runs/{id}/cancel into the live-run strip and run detail.
5. **Evidence-latency metric** (S bridge + S dash) — aggregate filedAt→checkedAt into
   /approvals/kpi; render median/p90 on /workers ConsideredApproval and trend it. The moat KPI
   becomes visible.
6. **Stale-cron badge** (S) — recipes list: enabled + cron + lastRun older than ~2× cadence →
   "hasn't fired" warn pill linking to doctor.
7. **Judge summary panel** (S) — /runs or run-detail section over /runs/judge-summary.
8. **Empty-state pass on /tasks, /inbox, /workers** (S) — use the existing EmptyState actions.
9. Webhook payload viewer on recipe detail (M) · variant promote/duplicate buttons (S) ·
   approval-insights replay UI (M, pairs with roadmap #15) · activation-metrics: decide
   surface-or-delete.

## D. Unknowns that need instrumentation, not code reading

- Route-visit counts (which dashboard pages are actually used) — a local counter into the
  existing on-disk analytics panel would answer without privacy changes.
- Feature usage: search, j/k nav, expert toggle, mobile PWA approvals.
- Cold-start walkthrough: fresh `init` in a clean VM, record every empty/confusing state —
  never yet done on a data-empty instance.
- Notification routing coherence (ntfy vs push vs inbox vs dashboard): design question, needs
  a decided answer, not measurement.
