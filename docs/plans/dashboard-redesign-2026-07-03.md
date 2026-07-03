# Dashboard redesign — 7 pages + 2 new deliverables (2026-07-03)

User-approved mockups: https://claude.ai/code/artifact/21d32382-dab6-4724-af35-da4d3270f19d
(tab switcher, top). Presentation/composition layer only — reuse `globals.css` tokens
and existing primitives; keep every route, deep link, keyboard shortcut, aria role,
and empty/error/loading state; verify light AND dark (`data-theme` dark) at ≤768px;
keep the humane copy voice (PRs #1074–#1076). One branch + PR per page/deliverable off
`main`; add a `docs/in-flight.md` entry before starting.

Build cadence: each page is built to spec (subagent to a precise brief), then all gates
(`tsc`, `tsc -p tsconfig.tests.core.json` where it scopes, inline-fontSize ratchet,
`vitest`, `next lint`) are re-run + reviewed before the PR. Merge on green.

## The 7 pages (mockup tab → target file) — ship order
1. **Recipes → Gallery** (R-A) — `app/recipes/page.tsx` — ✅ PR #1080 (card grid, filter chips, sparkline; side panel dropped for navigation).
2. **Recipe detail → Dossier** (D-A) — `app/recipes/[...name]/` — ✅ PR #1081 (sticky 280px identity rail + content stack; killed the Overview/Edit/Plan tab bar; doctor-first content card; YAML "what it does"; run history; Edit/Plan/Simulate/Compare relocated to rail links; Archive/Delete quiet danger zone at rail bottom).
3. **Inbox → Mail client** (I-B) — `app/inbox/page.tsx` — ✅ already built in an earlier session (`.inbox-twopane`/`.inbox-list-pane`/`.inbox-reader-pane`, folder chips, provenance strip, 65ch markdown, Replay/Trace/Archive/Delete toolbar, mobile single-pane + back app-bar) — matches this spec closely enough that no further work was needed; only cleanup was removing a dead unused `RecipeIcon` component.
4. **Workers → Roster** (W-A) — `app/workers/page.tsx` — card grid `minmax(320px,1fr)`; 64px SVG trust dial (arc=earned, tick=ceiling, "L{n}"/dashed "new"); 4-seg progress strip (filled/hatched-capped); leash sentence; promote strip w/ "Raise limit"; DotStrip footer; reversible-only note; three stat tiles replace the triage dot line; queue above grid; expert mode reveals classKeys/HBarList/ramp-vs-gate via DetailsFold.
5. **Home → Command Deck** (H-C) — `app/page.tsx` — dense 12-col bento; needs-attention (span 7) + live-now (span 5); row 2 (3× span 4): 24h run heatmap, vitals KV, top-recipes leaderboard. Remove quilt hero/kanban/first-run from landing (keep checklist only for genuinely-new workspaces).
6. **Marketplace → Storefront** (M-A) — `app/marketplace/page.tsx` — featured split hero + "Before you install" facts; horizontal-scroll themed shelves; tiles (risk pill + ↓count + Install/Review). Search replaces shelves with the flat filtered grid.
7. **Traces → Waterfall** (T-A) — `app/traces/page.tsx` — tree view default; each recipe_run a lane; rows `170px|track|70px` with timing bars (recipe_run blue, approval-wait amber, enrichment green, decision purple, error red); flat view stays behind the toggle.

## Deliverable 1 — Approvals page: "Considered" (`app/approvals/page.tsx`)
Evidence-first queue. Measured failure = rubber-stamping (0% reject, ~4s median); fix =
show the basis inline + friction proportional to blast radius.
- Header "Approvals — N waiting" + honesty pill "median decision this month: 4s · 0 denied"
  (reuse the /workers considered-approval latency aggregation — don't duplicate).
  Sub-line "Sorted by blast radius — the one that can't be undone is on top."
- Queue sorted irreversible → compensable → reversible, oldest-first within tier.
- Card header: blast badge (`⛔ irreversible · high` red / `↩ compensable` amber /
  `✓ reversible` green) from action-class `domain:reversibility:blastTier`
  (classification in `src/workers/`; no action-class → tool→reversibility fallback,
  mark "unclassified", never guess high) + plain sentence "<worker/recipe> wants to
  <verb object>" + waiting time.
- Irreversible + compensable → two-column body: LEFT "What exactly it will run"
  (command line / diff hunk / issue-PR body preview in mono recessed block) + "Why it
  fired" (trigger + `/runs/<seq>` link); if payload has no preview, show tool+args and
  label the gap ("no preview available"), never fabricate. RIGHT rail: "Worker record —
  this action class" (earned level + classKey + prior outcome count from
  `GET /gate/decisions?workerId=&classKey=` + trust store; "no trust record" if not a
  ramped worker) + "If it's wrong" (one consequence sentence from a small static map).
- **Evidence gate (irreversible only)**: Approve disabled until the user expands/clicks
  ≥1 evidence link ("🔒 Approve unlocks after you open the draft or the run"). Client-only.
- Reversible cards single-row (badge + sentence + wait + Approve/Deny), no gate.
- Deny… → one-field short-reason popover → existing deny call; persist the reason where
  the decision is already stored if the shape allows (else follow-up, no new store).
- Footer outcome loop: "Decided earlier today: N approved · <link>" + when an approved
  action has a visible outcome, "the push you approved yesterday: CI green, no revert →"
  (from existing runs/outcome data; omit if none).
- Keep polling, approve/deny endpoints + optimistic/error handling, approval-token
  semantics, empty state.

## Deliverable 2 — new "Today" page (`app/today/page.tsx`) — ADDITIVE
Inbox/Approvals/Workers/Overview all keep routes + full function. Today is a NEW route
composing their data into the 5-minute morning habit; every section deep-links out. Add
"Today" to the sidebar (top group, above Overview); do NOT replace Overview as `/`.
- Single 840px column. Hero: eyebrow "<weekday date> · overnight: N runs, M halts"
  (runs since 6pm yesterday local — `halts` window convention); headline "Morning.
  <X decisions>, one brief, and you're clear."; right 3-segment progress "0 of 3 done".
- **1 · Read the brief**: newest unread brief-type inbox item, body inline (existing
  sanitized-markdown renderer), capped height + "Open full note" → `/inbox?item=…`.
  Toolbar: "↻ Retry <name>" if the brief references a halted recipe (best-effort name
  match vs halt summary) + "Mark read ✓". No unread → collapsed "No new brief — last one
  yesterday 07:02 →".
- **2 · Clear the decisions**: one merged worst-first list — pending approvals (compact
  rows reusing Deliverable 1's blast badges + inline Approve/Deny; irreversible row shows
  "Open evidence →" to `/approvals`, no duplicated gate) + pending worker verdicts (reuse
  /workers review-queue component + "Looks real / Not real") + a single batch row for
  reversible approvals ("N reversible writes · Approve all"). Empty → "Nothing needs a
  decision."
- **3 · Glance at the team**: 2–4 rows from workers data (promotion-ready ok-dot "Raise
  limit →", recent demotions warn-dot, "N others quiet and healthy · full roster →").
  Reuse the workers fetch/summary (import/extract, don't copy-paste).
- Progress strip: §1 done on Mark-read/no-brief; §2 done when its list empties; §3 manual
  "✓ done". All done → sections collapse, green strip "You're clear — next brief tomorrow
  07:00" (next-fire from the brief recipe cron if resolvable). "done" ticks in localStorage
  keyed by date, reset daily. No backend changes.
- Data: compose from the endpoints the source pages already use; extract shared hooks into
  `dashboard/src/lib/` over duplicating. Fail soft per-section (one endpoint down → that
  section's error row, others still render).

Order: **Approvals first** — Today's §2 reuses its blast badges + row components.
