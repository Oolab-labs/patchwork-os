# Humane redesign — Recipe detail + Workers pages (2026-07-02)

**Problem** (product owner): both pages are hard for a non-tech-savvy person to understand visually;
they get discouraged. This is a ground-up page-level redesign proposal. Data model, endpoints, and
expert functionality stay; the default view changes.

**Persona**: non-technical solo operator / small-agency owner. Their questions, in order:
1. Is everything okay?
2. What needs ME right now?
3. What did my automation do for me?
4. Can I trust it with more?

They do not know: cron, Bayesian, LCB, action-class, blast tier, haltCategory, disposition,
`seq`, YAML, `expect:`, tokensMax.

---

## 1. Diagnosis — why the current pages discourage

Grounded in the current code (`dashboard/src/app/recipes/[...name]/page.tsx`, 1042 lines;
`dashboard/src/app/workers/page.tsx`, 1004 lines):

**Shared root causes**
- **Card-stack = report, not answer.** Both pages are vertical stacks of equal-weight cards.
  Nothing is visually dominant, so the user must read everything to learn anything. Recipe detail
  is a 7-card stack (Summary → Recent runs → Halts → Connectors → Inbox → Controls → Doctor →
  What-If); Workers is 3 meta-panels + N long worker cards.
- **Numbers before meaning.** "Success rate 43% over 50" (`page.tsx:782-790`), "% mean · N obs",
  "HIGH risk (62/100) — 3 write(s)" (`RunModal`, `page.tsx:257-264`). Raw numbers read as exam
  grades; the meaning ("it usually works", "this run will post to GitHub") is left to the user.
- **Jargon at the surface.** Raw cron strings in mono font (`scheduleString`, recipe page:584-590),
  halt-category pills like "agent narration-only" (`HALT_CATEGORY_LABEL`), hints that are
  engineer-speak ("A step's `expect:` assertion didn't match"), `seq` numbers, "Uninstall",
  "Doctor", "What-If Preview", "Simulate", "Plan", "Compare" — five sibling concepts no
  non-technical user can distinguish.
- **Diagnostics promoted to hero.** Doctor and What-If auto-run and occupy the recipe default view
  (`autoSimulate` defaults true, page.tsx:348). These are engineer tools; for the persona they are
  noise that reads as "something's wrong / this is complicated."
- **Instructions instead of buttons.** The workers "Ready for more independence" box tells the user
  to `set autonomyCeiling: 2 in this worker's .worker.yaml file` (workers page:811-814) — a dead
  end for someone who has never opened a terminal.
- **Sentences instead of visuals (workers).** The recent "speak-human" pass replaced jargon with
  prose — the page is now a wall of paragraphs (`editorial-sub` everywhere). Non-technical users
  scan; they don't read. State must be carried by color/position/size first, words second.
- **Three jobs interleaved (workers).** Reviewing filings (AwaitingConfirmationPanel), auditing
  your own honesty (ConsideredApprovalPanel), and managing team trust (WorkerCards) alternate down
  one column. The user can't form a mental model of "what do I do here."

**What already works (keep)**
- Plain-vocabulary maps (`PLAIN_LEVELS`, `DOMAIN_LABELS`, `taskName()` — workers page:84-142).
- The expert toggle pattern ("Show details", workers page:949-955) — right idea, extend everywhere.
- The confirm queue with Looks real / Not real buttons (workers page:307-429).
- Journey metaphor (5 stops, workers page:552-558) — right idea, needs visual compression.
- Attention-first fleet sort (workers page:911-924).
- Recipe action bar lifted above the fold (recipe page:709-747), adaptive run polling, inbox toast.

---

## 2. Design principles (both pages)

1. **One page answers one question above the fold.** Recipe detail: "Is this job doing its work?"
   Workers: "Who needs my decision?" Everything else is subordinate.
2. **Status ladder layout**, always in this order:
   BAND 1 status (one dominant medallion + verb-first sentence) → BAND 2 "Needs you" (actions,
   conditional) → BAND 3 "What happened" (story/timeline) → BAND 4 "How it works" → BAND 5
   folded expert details.
3. **Meaning → evidence → number.** Every stat becomes a sentence with the number as supporting
   detail: "Worked 9 of the last 10 times" + 10-dot strip, not "90%".
4. **Actions are buttons, never instructions.** If the backend can't do it yet (ceiling raise),
   ship a guided modal — never a bare YAML instruction.
5. **One "Show details" affordance**, page-level, persisted in localStorage, shared component.
   Expert content never deleted — folded.
6. **Empty states are onboarding.** Never a blank; always "here's the next step" with a button.
7. **Traffic-light discipline.** Green/amber/red carry state; grey is calm. No amber jargon pills
   in the default view.

Status medallion vocabulary (shared component, both pages):
- 🟢 "Working fine" / "On track"
- 🟡 "Waiting on you" (+ what, + one button)
- 🔴 "Stopped — needs attention" (+ plain reason, + one fix button)
- ⚪ "New — hasn't started yet" (+ onboarding step)

---

## 3. Recipe detail — redesign ("the job page")

**Purpose statement**: *"Is this job doing its work, and what has it done for me?"*

```
┌──────────────────────────────────────────────────────────┬───────────────┐
│  ← Recipes /  Morning Brief                              │  (sticky      │
│                                                          │   related     │
│  ┌────┐  🟢 Working fine                                 │   panel —     │
│  │ ✓  │  Ran this morning in 42s. Runs every day at 7:00 │   unchanged,  │
│  └────┘  — next run in 14 hours.                         │   expert      │
│                                                          │   only)       │
│  [▶ Run now]  [⏸ Pause]  [✎ Edit]        Show details ▸  │               │
├──────────────────────────────────────────────────────────┤               │
│  ⚠ NEEDS YOU (only when true)                            │               │
│  GitHub connection expired — the job stopped 3 times     │               │
│  this week because it can't sign in.   [Reconnect →]     │               │
├──────────────────────────────────────────────────────────┤               │
│  WHAT IT'S BEEN DOING          Worked 9 of last 10 ●●●●●●●●●○           │
│  Today      ✓ Ran (42s) → "Morning brief"     [Read it →]│               │
│  Yesterday  ✓ Ran (39s) → "Morning brief"     [Read it →]│               │
│  Mon        ✗ Stopped — couldn't reach GitHub [Why? →]   │               │
│  ...                                    [All activity →] │               │
├──────────────────────────────────────────────────────────┤               │
│  HOW THIS JOB WORKS                                      │               │
│  ① Reads your GitHub PRs  →  ② Summarizes with Claude    │               │
│  →  ③ Delivers to your Inbox                             │               │
│  Uses:  [GitHub ●] [Slack ●]                             │               │
├──────────────────────────────────────────────────────────┤               │
│  ▸ Details (folded: Doctor, Preview-what-it-would-do,    │               │
│    halts table, cron string, vars, Compare, Delete)      │               │
└──────────────────────────────────────────────────────────┴───────────────┘
```

**Band details**
- **Band 1 — Status header.** Medallion computed from data the page already has: `lastRunDerived`
  tone + halt summary + `enabled` + connector health. Schedule in human words (needs a small
  cron→English helper — none exists in the repo today; add `dashboard/src/lib/humanSchedule.ts`,
  handle `@every`, 5-field cron common cases, fall back to the raw string under details). "Pause"
  replaces "Disable" (same PATCH). Next-run time if derivable from the schedule.
- **Band 2 — Needs you.** Renders only when: recipe disabled with a non-manual trigger; last run
  halted; a required connector is disconnected (`connectorHealthMap` already computed); doctor
  reports unhealthy (reuse existing fetch, summarize to one sentence). Each row = one plain
  sentence + one fix button, derived from a new **owner-level phrasing map** for halt categories
  (sits beside `HALT_CATEGORY_HINT`, which stays for expert view). Examples:
  `auth_failure` → "It can't sign in to {service}." [Reconnect →]
  `rate_limited` → "{service} asked it to slow down — it will work again soon."
  `budget_exceeded` → "It hit its spending limit." [Raise limit →(details)]
  `missing_connector` → "It needs {service} connected before it can run." [Connect →]
- **Band 3 — Activity story.** Merges today's three cards (Recent runs, Halts, Latest inbox
  output) into one day-grouped timeline. Each row: outcome icon, plain verb, duration, and —
  the emotional payoff — the artifact it produced, linked ("→ 'Morning brief' [Read it]").
  Success framing as "Worked N of last M" + dot strip (10 dots max), replacing the % stat.
  Failed rows get the owner-level reason + [Why? →] which deep-links into the run detail.
- **Band 4 — How this job works.** Plain numbered step story derived from the existing plan data
  (the `_plan` page already computes steps; render names through a step-verb map, tool steps as
  "Reads/Writes/Sends…", agent steps as "Asks Claude to…"). Connector logos with health dots
  (reuse `ConnectorChip`). This kills the mystery of "what even is this thing."
- **Band 5 — Details (folded).** Doctor, What-If/Simulate (renamed "Preview what it would do"),
  full halts table with categories, raw cron/trigger/webhook path, vars, Compare versions, and a
  **danger zone** with "Delete this recipe" (replaces "Uninstall"; keep the type-to-confirm
  Dialog). Auto-simulate stops running in default view (perf + calm); it still auto-runs when
  details is open or `?simulate=1`.

**States**
- *Healthy*: green medallion, no Band 2.
- *Halted/attention*: red/amber medallion, Band 2 present, page is calm otherwise.
- *Never run*: white medallion, Band 3 replaced by onboarding: "This job hasn't run yet.
  [▶ Run it once to see what it does] — or wait for its schedule (tomorrow 7:00)."
- *Running*: medallion pulses "Running now — step 2 of 3", Band 3 top row live (reuse the
  adaptive 3s polling that already exists).
- *Paused*: grey wash + "Paused — it won't run until you resume. [Resume]".

**Run modal** (kept, reworded): risk banner becomes "This run will: post 1 comment to GitHub,
send 1 Slack message, ask Claude twice." (derive from the same simulation summary counts; tier
badge stays for expert). Vars keep descriptions, lose mono labels.

---

## 4. Workers — redesign ("the team page")

**Purpose statement**: *"Who needs my decision, and how is my team coming along?"*

```
┌────────────────────────────────────────────────────────────────┐
│  Your AI team — 3 workers                     Show details ▸   │
│  🟡 2 things need your review · 1 worker ready for a promotion │
├────────────────────────────────────────────────────────────────┤
│  REVIEW QUEUE (2)                                              │
│  Test Guardian filed: "Login test failing on main"             │
│      github.com/…/issues/91 · 2h ago  [✓ Looks real] [✗ Not real]│
│  Test Guardian filed: "Flaky retry in CI"                      │
│      github.com/…/issues/92 · 5h ago  [✓ Looks real] [✗ Not real]│
│  ▸ Past verdicts (12 · 10 real, 2 not)                         │
├────────────────────────────────────────────────────────────────┤
│  YOUR TEAM                                                     │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ 🅣 Test Guardian              ★ Ready for a promotion      │ │
│ │   Files issues for failing tests                           │ │
│ │   ▮▮▮▮▮▮▮▯▯▯ Asks first → 🔒 your limit                    │ │
│ │   "It's proven it can act on its own — you still have it   │ │
│ │    asking first."                    [Give more freedom →] │ │
│ └────────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ 🅡 Release Notes             Proving itself                │ │
│ │   Writes release notes                                     │ │
│ │   ▮▮▮▯▯▯▯▯▯▯ Just watching · 3 more confirmed wins to      │ │
│ │   advance                                    [See story →] │ │
│ └────────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ 🅓 Dependency Bump           ⚪ New — just watching         │ │
│ └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Band details**
- **Band 1 — Team header.** One sentence that triages the whole page: "N things need your review ·
  M ready for a promotion" or "🟢 All good — nothing needs you today." (computed from the data the
  page already fetches). The rubber-stamp honesty check (`ConsideredApprovalPanel`) collapses to a
  single amber sentence here *only when it triggers* ("Heads up: you've approved all 23 requests
  without ever saying no — trust below may be inflated"); its full KPI telemetry moves to details.
- **Band 2 — Review queue.** The existing `AwaitingConfirmationPanel` rows, but humanized: show the
  filing's *title* (fetch or derive from URL slug; fall back to URL), worker name, relative time.
  Buttons unchanged (they already POST /outcomes). `FiledOutcomesPanel` (verdict history) collapses
  to one disclosure line: "Past verdicts (12 · 10 real, 2 not) ▸" — history is reference material,
  not daily work.
- **Band 3 — Team roster.** Compact rows, not mega-cards. Each row: initial-avatar, name, one-line
  job description (from the worker manifest description; fall back to primary job's `taskName`),
  ONE 10-segment progress bar (5 journey stops × 2 segments) with the ceiling as a 🔒 "your limit"
  marker (replaces the ⚑ "leash" flag — locks are universally understood, leashes aren't), a
  status chip (★ Ready for a promotion / Proving itself / ⚪ New), and one contextual line. The
  current card content (JourneyStepper, JourneyTimeline "How it got here", per-task record,
  ramp-vs-gate divergences) moves into a **click-to-expand drawer** per worker — same components,
  relocated, nothing deleted.
- **Promotion affordance.** "[Give more freedom →]" opens a modal: "Test Guardian has earned the
  right to *act on its own, and you can undo it* for *filing issues* (14 real wins, 0 mistakes).
  Move its limit from *asks first* → *acts + undo*?" [Yes, promote] [Not yet].
  Backend note: ceilings live in `~/.patchwork/workers/*.worker.yaml`; there is **no PATCH
  endpoint today**. Interim: the modal's confirm shows the exact one-line command with a [Copy]
  button and a "why this is manual" note. Proper fix: small Bearer-gated
  `PATCH /workers/:id {autonomyCeiling}` on the bridge (one-PR slice, pairs with the
  ceiling-readiness receipt from docs/roadmap-plan-2026-07-02.md #9).
- **Progress framing.** "3 more confirmed wins to advance" uses the same computation as the
  readiness receipt (roadmap plan #9) — the two features share one pure function.

**States**
- *Flag off* (`PATCHWORK_FLAG_WORKER_AUTONOMY` unset): onboarding hero, not a blank: "Meet your AI
  team — workers do jobs on their own and earn your trust with receipts. 3 steps to turn on:
  ① start the bridge with the workers flag ② copy a starter worker ③ come back here." Detect via
  /status; link the runbook.
- *No workers*: template gallery — one card per `templates/workers/*` ("Test Guardian — watches
  your tests, files real failures") with copy-command affordance.
- *Cold start* (workers exist, no data): "⚪ New — just watching for now. It'll start building a
  record as your recipes run. Nothing for you to do yet."
- *Active + nothing pending*: green header sentence — explicitly "all caught up", never blank.

---

## 5. Shared vocabulary map (default view; raw terms remain in details)

| Today | Redesign |
|---|---|
| Success rate 43% over 50 | "Worked 9 of last 10 times" + dot strip |
| halt / halted | "stopped" + plain reason sentence |
| `agent narration-only`, `expect failed`… pills | owner phrasing map (engineer labels → details) |
| cron `0 7 * * *` | "Every day at 7:00 — next in 14h" |
| Disable / Uninstall | Pause / Delete this recipe |
| Doctor | "Check for problems" |
| What-If Preview / Simulate | "Preview what it would do" |
| risk HIGH (62/100) | "This run will: post 1 comment, send 1 message…" |
| autonomyCeiling / ⚑ leash | 🔒 "your limit" |
| L0–L4, obs, % mean | journey stops + "N real wins, M mistakes" |
| disposition confirmed/junk | "looks real" / "not real" (already done) |
| ready to advance | "★ Ready for a promotion" |

---

## 6. What gets deleted or demoted (nothing is lost)

| Element | Fate |
|---|---|
| Recipe Summary card (5-stat grid) | Dissolved into Band 1 sentence + Band 3 dot strip |
| Halts card (amber pills) | Band 2 plain sentences; full table → details |
| Controls card | Primary actions in header; Plan/Simulate/Compare/Delete → details + danger zone |
| Doctor + What-If auto-run panels | Details fold; auto-run only when open or deep-linked |
| Workers ConsideredApprovalPanel | One conditional header sentence; telemetry → details |
| FiledOutcomesPanel | Disclosure line under Review queue |
| WorkerCard mega-cards | Roster rows + per-worker drawer (same components inside) |
| ⚑ leash flag, YAML instructions | 🔒 limit marker + promotion modal |

## 7. Implementation slices (each one PR + verify loop)

- **S1 — shared primitives**: `StatusMedallion`, `DotStrip`, `DetailsFold` (persisted expert mode,
  replaces workers-page local `expert` state), `lib/humanSchedule.ts`, owner-level halt phrasing
  map in `dashboard/src/lib/haltPhrasing.ts`. Pure additive components + unit tests.
- **R1 — recipe Band 1+2** (status header, needs-you band, actions rework, danger zone move).
  Playwright: seed a halted recipe → medallion red, needs-you sentence + fix button; healthy →
  green, no band 2.
- **R2 — recipe Band 3** (activity story: merge runs+outputs+halts, day grouping, dot strip).
  Playwright: run with inbox output → row shows "→ artifact [Read it]" linking to inbox.
- **R3 — recipe Band 4+5** (step story from plan data; fold Doctor/Simulate/expert content).
  Playwright: details closed → no simulate network call; open → panels render.
- **W1 — workers Bands 1+2** (header triage sentence, merge panels, verdicts disclosure).
- **W2 — workers roster + drawer** (rows, progress bar with 🔒, relocate card content).
- **W3 — promotion modal** (+ optional bridge `PATCH /workers/:id` slice; else copy-command interim).
- **W4 — empty/onboarding states** (flag-off hero, template gallery, cold-start).

Order: S1 → (R1‖W1) → (R2‖W2) → (R3‖W3) → W4. Every slice independently shippable; expert mode
keeps all current information reachable, so no capability regression at any point.

## 8. Verification approach

- Component tests per new primitive; page tests extend existing
  `workers/__tests__/page.test.tsx` + add recipe-hub equivalents.
- Playwright "glance test" per page: within the first viewport (1280×800, no scroll) the DOM must
  contain (a) a status medallion, (b) either a needs-you row or an explicit all-clear sentence,
  (c) zero occurrences of the banned-jargon list (cron regex, `L[0-4]`, `haltCategory` labels,
  `obs`, `seq`) outside `[data-details]` regions — an automatable proxy for "non-tech readable".
- Manual: 5-second test with a non-technical person: show each page, ask "is anything wrong? what
  would you click?" — success = correct answer for healthy, halted, and needs-review fixtures.

## 9. Open decisions

1. **Word for recipes**: keep "recipe" (brand) or switch page copy to "job"? Proposal uses
   "job" in sentences, "recipe" in chrome. Needs a call for consistency site-wide.
2. **PATCH /workers/:id for ceiling raise** — build the small bridge endpoint (proper) or ship
   copy-command interim first? Endpoint touches the trust boundary (write path must be
   Bearer-gated, never a recipe step/MCP tool — same rule as /outcomes).
3. **Filing titles in the review queue** require either a GitHub fetch or storing the title at
   capture time (the outcome pipeline currently stores only URLs) — small bridge change, worth it.
4. **Run-detail page** (`/runs/[seq]`) is the natural third page for this treatment (the "Why? →"
   links land there) — in scope for a follow-up, not this redesign.

## 10. R1 review feedback (2026-07-03) — triage

Product-owner review of the shipped R1 recipe page. Items done in R1 vs. routed
to later slices (nothing dropped):

**Done in R1 (follow-up commit):**
- Group multiple disconnected connectors into ONE "Needs you" row + single
  "Go to Connections" CTA (was N repetitive rows). `lib/recipeStatus.ts`.
- Drop the redundant second Resume (medallion + action bar already offer it).
- Remove the duplicate inline Edit button (the tab is its home).
- Fold Doctor + What-If Preview under "Show details" (were always-expanded; the
  What-If's full projected-action list made the page enormous). Deep-links
  `?diagnose=1` / `?simulate=1` still force-render + auto-run. Renamed in the
  fold: "Doctor" → "Check for problems", "What-If Preview" → "Preview what it
  would do", each with a one-line explainer. This also makes "Show details"
  visibly reveal content (was the #9 complaint).

**Routed to R2 (activity story / summary dissolve):**
- Summary 4-col grid is sparse; `cron (unknown)` is a dead end (→ "Set a
  schedule →"); blank Success rate / Avg duration need "No runs yet" context.
- Connector info duplicated across description tags, Needs-you, sidebar, and the
  Connectors-required card — consolidate to one home; sidebar should instead
  surface "Last run / Next scheduled run".
- Empty-state onboarding for a never-run recipe (illustration + clear CTA).

**Routed to R3 (fold expert + reorder + run modal):**
- Section order: promote Controls above Summary; Doctor to the very bottom.
- Surface the What-If risk score as a badge in the header area (not buried).
- What-If projected-actions list: collapsed-by-default accordion ("Show all N").

**Layout-owned (separate from the redesign slices — layout.tsx / RelationStrip):**
- Status badge beside the mono H1 is low-contrast; make the page state obvious
  (colored left-border or a sticky status pill) now that the medallion is the
  real signal — consider dimming the layout pill.
- Dense multi-line description → "Show more" collapse + a soft length limit at
  entry time.
- Quick-links "Halts" pill always renders selected/filled with no count — add a
  count badge (like the sidebar "Live 6") or fix the selected-state styling.
