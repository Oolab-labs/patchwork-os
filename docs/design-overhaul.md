# Patchwork OS — Dashboard UI/UX Overhaul

> Status: ready to implement. Dashboard-only scope; landing-site work and the named-agent persona system are out of scope. Authored 2026-05-25, revised 2026-05-25.

This brief is the single source of truth for the upcoming UI/UX overhaul of the Patchwork dashboard (`dashboard/`). It supersedes any prior design notes. Implementing agents may read this document standalone — all wave context is included inline.

---

## TL;DR — what to ship first

The five highest-leverage implementations, in dependency order:

1. **Showcase dark theme + cool accent tokens** — `dashboard/src/app/globals.css`. Foundation tokens that every downstream surface (FlowSvg, motion, marketplace simplification) composes against.
2. **`<FlowSvg>` read-only flow visualization** — `dashboard/src/app/recipes/[...name]/_edit/_components/FlowSvg.tsx`. ~250 LOC, ~3.5 dev-days; gives recipes the visual identity they currently lack without committing to a node-canvas editor. Mounts in the plan page and run page.
3. **Recipes hub redesign — List/Cards toggle** — `dashboard/src/app/recipes/page.tsx`. The flat 7-column horizontal-scroll table is the documented eyesore. Cards-default with a List fallback fixes the desktop and mobile experience at the same time.
4. **Dashboard home page tightening** — `dashboard/src/app/page.tsx`. Remove `ToolCallsWidget`, the `EntityTimeline + ActivityThread` grid; gate Telemetry when zero data; keep the monitoring-console identity but compressed.
5. **Marketplace card simplification** — `dashboard/src/app/marketplace/page.tsx`. Move trust pills behind a tooltip; surface connector glyphs; let the install button breathe.

Tier-1 token primitives (#1) must land first. Tier-2 surfaces (#2–#5) can ship in parallel.

---

## Cross-wave findings (dashboard-relevant)

The convergent insights that survive the dashboard-only scope cut:

**1. The recipes hub flat table is the documented eyesore.** Component patterns *[wave 1 / ad1ecc6145d4df838]*, mobile *[wave 2 / aab786f1adb666306]*. `dashboard/src/app/recipes/page.tsx` ships a 7-column horizontal-scroll table on desktop and a sticky-`MobileRunBar`-patched scrollable table on mobile. Convert to scannable cards on desktop and single-column cards on mobile.

**2. The dashboard home page is a 13-panel monitoring console; tighten composition.** Main dashboard *[wave 3 / a2fb3adcbf3239ca9]*. `dashboard/src/app/page.tsx` currently mounts: `FirstRunChecklist`, `QuiltHero`, `NeedsAttentionBand`, `LiveWire`, `LiveRunsStrip`, Telemetry section, `ToolCallsWidget`, `EntityTimeline` + `ActivityThread` grid, `RecipesAtAGlance`, `RecipeLeaderboard`. Three of these belong on `/activity`. Telemetry should be gated when zero data exists.

**3. Read-only flow visualization closes a real perception gap at low cost.** Workflow editor *[wave 2 / a761afdb21bbfe303]*, workflow page pixel spec *[wave 3 / a830b244ab0aaf68f]*. Relay.app — a billion-dollar competitor — explicitly chose a readable vertical list over a node canvas. YAML round-trip is the hard problem, not rendering. ~250 LOC for read-only SVG vs. 3–4 weeks for a full editor.

**4. Single bright accent improves visual focus; existing multi-color (orange + err + warn + info) is noisy.** Visual *[wave 1 / aeecad115cd19b2f3]*, main dashboard *[wave 3 / a2fb3adcbf3239ca9]*, workflow page *[wave 3 / a830b244ab0aaf68f]*. Add `--accent-cool: #0787ff` alongside the existing orange `#c5532a` and reserve it for highlights: FlowSvg running state, focused step indicators, sparkline strokes, `+N` connector pill text.

**5. Compose status from `color-mix()` and existing tokens; reject new hex literals.** Workflow page *[wave 3 / a830b244ab0aaf68f]*, visual *[wave 1 / aeecad115cd19b2f3]*. Status badges and surface tints compose from `--ok`, `--err`, `--accent-cool`, `--bg-1`, `--line-2`. Hex literals in component CSS are a regression.

**6. Reject framer-motion dependency.** Motion *[wave 2 / a6c1ac511eaa61090]*. The dashboard already ships 14+ CSS keyframes; the team is proven capable. A spring-physics library is not justified by the use cases (row entry, FLIP rank shuffle, freshFlash on new activity rows).

---

## Implementation roadmap

Tiered by dependency + leverage. Tier 1 unblocks downstream work; Tier 4 ships independently. Within each tier, items are ordered by leverage descending.

### Tier 1 — Foundation tokens (build before everything else)

These items have no dependencies on each other and unblock most of Tier 2.

---

> **Showcase dark theme in `globals.css`** — *Tier 1, leverage: high, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — add `[data-theme="showcase"]` block alongside existing `:root`
>
> **Spec:** Opt-in dark mode triggered by `<html data-theme="showcase">`. Default stays cream `#f3efe5`. The showcase theme is the dark variant for marketing screenshots, the future presentation mode, and dark-preferring users.
>
> ```css
> [data-theme="showcase"] {
>   --canvas: #0a0a0a;
>   --surface: #121212;
>   --recess: #1f1f1f;
>   --bg-0: #0a0a0a;
>   --bg-1: #121212;
>   --bg-2: #1f1f1f;
>   --bg-3: #2a2a2a;
>   --raised: #2a2a2a;
>   --ink-1: #ffffff;
>   --ink-2: #a1a1a1;
>   --ink-3: #737373;
>   --line-1: #2a2a2a;
>   --line-2: #1f1f1f;
>   --accent: #0787ff;
>   --accent-pill-bg: #041233;
>   --accent-pill-ink: #0787ff;
>   --r-hero: 24px;
>   --shadow-cta-primary:
>     inset 0 1px 0 1px rgba(255,255,255,0.3),
>     0 6px 12px rgba(43,149,255,0.3);
>   --glow-icon: 0 0 8px #0787ff;
> }
> ```
>
> `--raised` is a 4th background level for elevated/hovering elements (popovers, dropdowns, tooltips, drag previews). Kilo's measured dark mode has four levels *[wave 3 / a2fb3adcbf3239ca9]*; the previous three-level proposal had surfaces that float above cards merging visually onto `--bg-2`.
>
> Do not retire cream. Cream is correct for daily-driver dashboards used in sunlight on laptops. Showcase is opt-in.
>
> **Unblocks:** dark-mode dashboard, future presentation mode, screenshot captures.
>
> **From:** wave 1 (aeecad115cd19b2f3).

---

> **Cool accent additions (global, not theme-gated)** — *Tier 1, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — add cool accent variables to `:root`
>
> **Spec:** Even on the default cream theme, expose the cool accent as a token so a small set of surfaces (link hovers, focused step badges in FlowSvg running state, info chips, sparklines) can render in blue without forcing a theme switch.
>
> ```css
> :root {
>   --accent-cool: #0787ff;
>   --accent-cool-glow: rgba(7,135,255,0.3);
>   --r-hero: 24px;
>   --glow-icon: 0 0 8px var(--accent-cool);
>   --hover-bg: color-mix(in srgb, var(--ink-1) 4%, transparent);
> }
> ```
>
> `--hover-bg` is the canonical hover background shift for new surfaces. Kilo's measured hover *[wave 2 / a6c1ac511eaa61090]* is a quiet background-color change with no transform — no jumps. Apply via `.interactive:hover { background: var(--hover-bg); }`. Existing components keep their custom hover treatment; this token is for new surfaces and explicit normalization passes.
>
> Reserve `--accent-cool` for: (a) FlowSvg "running" status badge, (b) selected sidebar item glow, (c) sparkline stroke on stat cards, (d) `+N` connector overflow pill text. Do NOT use for primary CTAs (those stay orange `var(--accent)` on default cream) or destructive actions.
>
> **Unblocks:** FlowSvg running state, AgentCard accent strip, MetricStrip sparkline stroke.
>
> **From:** wave 1 (aeecad115cd19b2f3), wave 3 (a830b244ab0aaf68f).

---

> **Motion token `--ease-out`** — *Tier 1, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — add motion vocabulary at top of `:root`
>
> **Spec:** Single shared easing token used by every fade-in, slide-in, and FLIP transition throughout the overhaul.
>
> ```css
> :root {
>   --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
>   --motion-fast: 180ms;
>   --motion-base: 320ms;
>   --motion-slow: 1000ms;
>   --stagger-row: 60ms;
> }
> ```
>
> Existing Patchwork keyframes (`fadeInUp`, `fade-in`) stay; just retarget them to `var(--ease-out)`. Search `dashboard/src/app/globals.css` for `cubic-bezier` and unify.
>
> Measured entry motion *[wave 2 / a6c1ac511eaa61090]*: 1000ms settle, spring stiffness 100 / damping 10 / bounce 0.3 ≈ `cubic-bezier(0.16, 1, 0.3, 1)`. translateY palette: 10 / 12 / 24 / 32 / 40 / 72 px. Default row-entry distance: 24px.
>
> **Unblocks:** page-mount stagger on overview cards, slideInRight on LiveRunsStrip, FLIP on RecipeLeaderboard, freshFlash on ActivityTicker.
>
> **From:** wave 2 (a6c1ac511eaa61090).

---

> **Display heading variant** — *Tier 1, leverage: low, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — add `.editorial-h1.display` variant
>
> **Spec:** Existing dashboard scale (`editorial-h1` `clamp(22px, 2.4vw, 30px)`) stays the in-app default. New `editorial-h1.display` variant `clamp(40px, 6vw, 56px)` for marketing-grade hero blocks within the dashboard — primarily `marketplace/page.tsx` hero and any future "showcase" pages.
>
> ```css
> .editorial-h1.display {
>   font-size: clamp(40px, 6vw, 56px);
>   line-height: 1;
>   letter-spacing: -1.5px;
>   font-weight: 600;
> }
> ```
>
> **Unblocks:** marketplace hero block; future presentation surfaces.
>
> **From:** wave 1 (aeecad115cd19b2f3).

---

### Tier 2 — Headline visual transformations

Four items. The user-visible payoff of the overhaul. All depend on at least one Tier-1 primitive.

---

> **`<FlowSvg>` read-only flow visualization** — *Tier 2, leverage: high, effort: medium*
>
> **Files:**
> - `dashboard/src/app/recipes/[...name]/_edit/_components/FlowSvg.tsx` — new component
> - `dashboard/src/app/recipes/[...name]/_edit/_components/flowLayout.ts` — pure layout algorithm
> - `dashboard/src/app/recipes/[...name]/_plan/page.tsx` — add `[Flow] [Table]` tab toggle, default Flow when steps ≤ 12
> - `dashboard/src/app/runs/[seq]/page.tsx` — add Flow tab as third tab alongside `Steps | Execution Plan`; live `stepResults` from the existing SSE stream
>
> **Spec:** Read-only SVG, no canvas editor, no library dependency. ~250 LOC total. Pixel-faithful spec from *[wave 3 / a830b244ab0aaf68f]*:
>
> - **Node**: 200×56, radius 10, fill `var(--bg-1)`, stroke `var(--line-2)` 1px.
> - **Icon container**: 40×40 inset (8, 8), radius 8, fill `var(--bg-2)`. Brand SVG from `dashboard/public/connectors/<id>.svg` centered if connector resolvable; else generated mono initial.
> - **Title**: 14/700 `var(--ink-1)` at (56, 22).
> - **Subtitle**: 11/400 `var(--ink-3)` at (56, 40).
> - **Status badge**: 28px circle, 2px stroke, positioned at top-right of the node (`node.x + 200 + 8`, `node.y - 8`). Status colors compose with `color-mix()`:
>
> | Status | Badge fill | Badge stroke | Glyph |
> |---|---|---|---|
> | ok | `color-mix(in srgb, var(--ok) 20%, var(--bg-1))` | `var(--ok)` | ✓ |
> | error | `color-mix(in srgb, var(--err) 25%, var(--bg-1))` | `var(--err)` | ! |
> | running | `color-mix(in srgb, var(--accent-cool) 20%, var(--bg-1))` | `var(--accent-cool)` | ◍ rotating |
> | pending | `var(--bg-1)` | `var(--line-2)` | ⋯ |
> | skipped | `var(--bg-2)` | `var(--ink-3)` | − |
>
> - **Edge**: cubic Bezier (NOT orthogonal), `stroke = var(--line-1)`, 1.5px, open-circle port indicators 12px at each end.
> - **Canvas**: `fill = var(--bg-0)`, 18px dot grid with `var(--line-2)` dots radius 0.5 (subtle, near-invisible on cream).
> - **Branch fan-out**: single output port → multiple Bezier curves to multiple input ports. No diamond/switch node.
> - **Branch convergence**: single input port receives multiple Beziers.
>
> **Layout algorithm** (`flowLayout.ts`):
> 1. Rank each step by longest path from root (Kahn's algorithm).
> 2. Within column, stack siblings top-to-bottom in declaration order.
> 3. Constants: `NODE_W=200`, `COL_GAP=80`, `ROW_GAP=28`, `PAD=24`.
> 4. Returns `{ nodes: {id, x, y, status}[], edges: {fromId, toId}[] }`.
>
> Click a node → push hash `#step-<id>` on the URL → `_edit/page.tsx` already scrolls to YAML line for that step ID (existing behavior). Saving stays YAML-only — flow is read-only.
>
> Skip mid-edge "+" buttons. They imply editability the surface doesn't support.
>
> Choice of read-only flow over node-canvas editor is deliberate: Relay.app *[wave 2 / a761afdb21bbfe303]* — a billion-dollar competitor — explicitly chose readable-list over node canvas. YAML round-trip is the hard problem, not rendering. ~3.5 dev-days vs. 3–4 weeks for a full editor.
>
> **Unblocks:** users see recipe structure at a glance for the first time; basis for any future v2 deep-link insertion.
>
> **From:** wave 2 (a761afdb21bbfe303), wave 3 (a830b244ab0aaf68f).

---

> **Recipes hub redesign — List/Cards toggle** — *Tier 2, leverage: high, effort: medium*
>
> **Files:**
> - `dashboard/src/app/recipes/page.tsx` — replace flat HTML table; introduce view toggle + grid renderer
> - `dashboard/src/components/RecipeHubCard.tsx` — new component
>
> **Spec:** The current 7-column horizontal-scroll table is the documented eyesore *[wave 1 / ad1ecc6145d4df838]*. Convert to a clean card grid with a List/Cards segmented toggle.
>
> **Toggle:** segmented control in the page head, top-right. Two segments: `Cards · List`. `localStorage` key `patchwork:recipes-hub:view`. Default to Cards for ≤ 12 recipes, List otherwise (computed on initial render; user choice persists). On mobile < 768px, force Cards regardless of stored preference (replaces the documented horizontal-scroll-table workaround).
>
> **Card** (`RecipeHubCard.tsx`): 280×140 default, padding 16px, `var(--bg-1)` background, 14px radius, 1px `var(--line-2)` border. Layout:
>
> - Top row: recipe name 16/600 `var(--ink-1)` truncated; status pill top-right (latest-run state) using the same color-mix mapping as FlowSvg badges.
> - Trigger type row: 12/500 `var(--ink-2)` with small icon (cron clock, file-watch, manual hand).
> - Run count: 12/400 `var(--ink-3)` "42 runs · last 2h ago".
> - Bottom-right action: `[Open]` ghost button, 32px height, 10px radius.
>
> No persona / avatar / role copy — cards are info-dense, not identity-driven.
>
> **List view:** unchanged 7-column table for the power-user use case (sortable columns, more rows on screen). The toggle is the contract; both views render from the same data.
>
> Apply the same Cards-default pattern to `dashboard/src/app/marketplace/page.tsx` mobile breakpoint (< 768px → single-column cards), but the marketplace card layout is covered separately below.
>
> Keep the existing `MobileRunBar` component — it's load-bearing for the "tap run now" gesture.
>
> **Unblocks:** mobile users on the recipes hub stop scrolling sideways; desktop users scan structure not columns.
>
> **From:** wave 1 (ad1ecc6145d4df838), wave 2 (aab786f1adb666306).

---

> **Marketplace card simplification** — *Tier 2, leverage: high, effort: medium*
>
> **Files:**
> - `dashboard/src/app/marketplace/page.tsx` — restructure `RecipeCard` layout
> - `dashboard/src/components/MarketplaceTrustTooltip.tsx` — new component (or inline if simple)
> - `dashboard/src/components/ConnectorBadgeRow.tsx` — new component
>
> **Spec:** The current marketplace `RecipeCard` is dense with competing signals: risk pills + approval pills + network pills + file-io pills all competing for attention. The install affordance loses the competition.
>
> **New layout** (top to bottom):
> 1. Recipe name 18/600 `var(--ink-1)`.
> 2. Description 14/400 `var(--ink-2)`, line-clamp-3 (was line-clamp-2). Reclaim space the pills used to occupy.
> 3. `<ConnectorBadgeRow connectors={r.connectors} />`: first 2 connectors as 16×16 SVGs from `dashboard/public/connectors/<id>.svg` (see Tier 3 connector glyph item), then `+N` pill `var(--accent-pill-bg)` text `var(--accent-cool)` 11/600 if `connectors.length > 2`.
> 4. Footer row: small info icon (16×16 `var(--ink-3)`) with `<MarketplaceTrustTooltip>` showing the full risk + approval + network + file-io detail on hover/focus. Install button on the right, primary style, 40px height (was 32px), `var(--accent)` fill on cream / `var(--accent-cool)` on showcase.
>
> The trust tooltip is keyboard-accessible (`tabindex="0"` on the icon, `aria-describedby` wiring) and shows the same metadata that was inline; nothing is hidden, only relocated. Discoverability cost is acceptable because the install gate at run-time still surfaces these capabilities.
>
> **Unblocks:** marketplace cards scan; install becomes the obvious next action.
>
> **From:** wave 1 (ad1ecc6145d4df838).

---

> **Dashboard home page tightening** — *Tier 2, leverage: high, effort: medium*
>
> **Files:**
> - `dashboard/src/app/page.tsx` — remove three panels; gate one section
>
> **Spec:** The home page currently mounts 13 panels. Three of them belong on `/activity`; one of them shows four "0" tiles for new users.
>
> **Remove from home** (link to `/activity` from the relevant section header):
> - `ToolCallsWidget`
> - The `grid-2` block containing `EntityTimeline` + `ActivityThread`
>
> **Gate**: the Telemetry strip should not render when both `recipes.length === 0` and `runs.length === 0`. Four "0" tiles look broken on first visit.
>
> **Keep** the monitoring-console identity: `QuiltHero`, `NeedsAttentionBand`, `LiveWire`, `LiveRunsStrip`, Telemetry (gated), `RecipesAtAGlance`, `RecipeLeaderboard`. `FirstRunChecklist` moves to layout (Tier 3 item below).
>
> **Order on home after tightening:**
> 1. `QuiltHero` (drop marketing tagline; keep bridge status row)
> 2. `NeedsAttentionBand`
> 3. `LiveRunsStrip`
> 4. Telemetry strip (gated)
> 5. `RecipesAtAGlance`
> 6. `RecipeLeaderboard`
> 7. `LiveWire` (demoted below the fold)
>
> `FirstRunChecklist` is mounted in `layout.tsx` (Tier 3) so it persists across routes.
>
> **Unblocks:** home page reads as a directory, not a stream; new users see a populated-feeling page; cognitive load drops from 13 panels to ~7.
>
> **From:** wave 3 (a2fb3adcbf3239ca9).

---

### Tier 3 — Content + flow improvements

Four items. Higher copy + IA leverage than visual rebuilds.

---

> **Empty-state copy rewrites** — *Tier 3, leverage: high, effort: small*
>
> **Files:**
> - `dashboard/src/app/marketplace/page.tsx` — rewrite empty state block
> - `dashboard/src/app/recipes/page.tsx` — rewrite empty state block
> - `dashboard/src/app/runs/page.tsx` — rewrite empty state block; add primary CTA
> - `dashboard/src/app/sessions/page.tsx` — tighten copy; remove passive Refresh button
>
> **Spec:** Current marketplace empty state reads "registry appears empty / check your connection" — *[wave 2 / ac747695d1ae3248d]* flagged this as reading like a bug. Concrete replacements:
>
> | Page | Empty state |
> |---|---|
> | Recipes hub | "**No recipes yet.** Pick one from the marketplace or write one with `patchwork recipe new`. [Open Marketplace] [Describe a Recipe]" |
> | Marketplace | "**Nothing installed yet.** Start with `morning-brief` (Gmail + Calendar digest), `inbox-triage` (Linear auto-tag), or `test-failure-triage` (CI watcher). [Browse Starters] [Generate Custom]" |
> | Runs | "**No runs yet.** Run a recipe manually with `patchwork recipe run <name>`, or trigger one from the recipes hub. [Open Recipes]" |
> | Sessions | "**No active Claude sessions.** Sessions start when an editor connects to the bridge. The bridge auto-starts on login." |
>
> Specifically name the starter recipes (`morning-brief`, `inbox-triage`, `test-failure-triage`). Remove the passive "Refresh" button on sessions; refresh is automatic on focus.
>
> **Unblocks:** new users land on populated-feeling pages even before they have data.
>
> **From:** wave 2 (ac747695d1ae3248d).

---

> **Move `FirstRunChecklist` mount to `layout.tsx`** — *Tier 3, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/app/layout.tsx` — add `<FirstRunChecklist />` between sidebar and main outlet
> - `dashboard/src/app/page.tsx:1103` — remove the current home-only mount
>
> **Spec:** *[wave 2 / ac747695d1ae3248d]* found that `FirstRunChecklist` is genuinely better than anything competitors ship (4-step funnel, live-probing, dismiss-aware). But it only mounts on the home page. OAuth-callback landings (`/connections?callback=...`) and direct-link arrivals don't see it.
>
> Move the component to layout level. Its existing `dismissed` localStorage gate means it disappears the moment the user completes step 4 or explicitly dismisses; no extra logic needed.
>
> Visual position: floating top-right card, 320px wide, `position: fixed; top: 80px; right: 24px; z-index: 30`. On mobile, becomes a bottom sheet (existing component already handles this).
>
> Don't add a `/welcome` route as a sibling — *[wave 2 / ac747695d1ae3248d]* explicitly rejected it as attention-splitting.
>
> **Unblocks:** new users completing OAuth flow on their first session see the next step instead of an empty dashboard.
>
> **From:** wave 2 (ac747695d1ae3248d).

---

> **Detail page improvements (runs + sessions)** — *Tier 3, leverage: medium, effort: medium*
>
> **Files:**
> - `dashboard/src/app/runs/[seq]/page.tsx` — sticky failure banner; auto-expand failed steps; top-right action zone
> - `dashboard/src/app/sessions/[id]/page.tsx` — same pattern for session-level halts
>
> **Spec:** Failed runs currently surface their halt reason midway down the page; successful steps and failed steps render identically expanded. Detail pages need a clearer information hierarchy.
>
> **Sticky failure banner** at top of `/runs/[seq]/page.tsx` when `run.status === "halted" | "error"`:
> - `position: sticky; top: 0`; padding 12 16; `var(--err)` left border 4px; `color-mix(in srgb, var(--err) 8%, var(--bg-1))` background.
> - Title 14/600: "Run halted: <reason category>".
> - Halt reason text 13/400, 1-3 lines from the `haltReason` field.
> - Right side: small "Jump to first failure" link → scrolls to first error step.
>
> **Step expand/collapse defaults:**
> - Failed steps (`status === "error"`): auto-expand on mount; show full output + stderr.
> - Skipped steps: collapsed.
> - Successful steps: collapsed by default; expandable chevron 16×16 in step header.
>
> **Top-right action zone** (same coordinate on both pages): horizontal row of three buttons, 32px height each, 8px gap.
> - `Rerun` — primary on runs page, hidden on sessions.
> - `Cancel` — visible only when status is `running` or `pending`.
> - `Copy URL` — ghost button, always visible; copies the canonical run/session URL to clipboard.
>
> Sessions page applies the same banner + action zone pattern; halts on sessions are rarer but the affordance should match.
>
> **Unblocks:** triaging a failed overnight run takes one screen instead of five scrolls.
>
> **From:** wave 3 (a2fb3adcbf3239ca9).

---

> **Connector glyph sourcing — SimpleIcons** — *Tier 3, leverage: high, effort: small*
>
> **Files:**
> - `dashboard/public/connectors/` — 14 SVG files, kebab-case matching `normalizeConnectorId()`
> - `dashboard/public/connectors/NOTICE.md` — new attribution file
> - `LICENSE-THIRD-PARTY.md` (repo root) — add line item (create file if absent)
>
> **Decision:** **SimpleIcons** (`simple-icons` npm package v11+). Single CC0-licensed source, all 14 connectors present, uniform `0 0 24 24` viewBox, single-path monochrome treatment.
>
> **Why not vendor brand kits.** 14 vendors → 14 distinct licenses. Slack prohibits color modification under 50px; Google requires attribution; Atlassian bars derivative SVGs without permission. SimpleIcons collapses all 14 under one CC0 1.0 Universal license with no per-vendor approval workflow.
>
> **Sizing:**
> - Source viewBox: `0 0 24 24` (SimpleIcons default — do not modify).
> - Rendered size in marketplace `ConnectorBadgeRow`: **16×16**.
> - Rendered size in FlowSvg node icon container: **24×24** (centered in 40×40 container).
>
> **Color strategy: `currentColor`-based.**
> - Set `fill="currentColor"` on the root `<svg>` element.
> - Strip all hardcoded `fill="#hex"` attributes from inner paths.
> - Rationale: dashboard supports cream + dark (showcase); brand-color at 16px on a dark surface looks muddy.
>
> **Optional brand-color hover** keyed to the existing `lib/registry.ts` `connectorColor()` map:
>
> ```css
> .connector-chip[data-connector="slack"] svg  { color: #4A154B; }
> .connector-chip[data-connector="github"] svg { color: #181717; }
> /* etc. — driven from connectorColor() */
> ```
>
> **Post-download cleanup:**
> 1. `s/<svg /<svg fill="currentColor" /` on every file.
> 2. Strip any inline `fill="#..."` attributes from descendant nodes.
> 3. Rename `googlecalendar.svg` → `google-calendar.svg` and `googledrive.svg` → `google-drive.svg` to match `normalizeConnectorId()` slugs.
>
> **File list** (all under `dashboard/public/connectors/`, kebab-case):
>
> `gmail.svg`, `google-calendar.svg`, `google-drive.svg`, `linear.svg`, `github.svg`, `slack.svg`, `asana.svg`, `discord.svg`, `gitlab.svg`, `jira.svg`, `confluence.svg`, `notion.svg`, `hubspot.svg`, `sentry.svg`.
>
> **NOTICE file** at `dashboard/public/connectors/NOTICE.md`:
>
> ```
> Connector glyphs from SimpleIcons (https://simpleicons.org)
> Icons: CC0 1.0 Universal. Brand names and logos are trademarks
> of their respective owners. Use of these marks does not imply
> endorsement by or affiliation with the trademark holders.
> ```
>
> Add a one-liner to root `LICENSE-THIRD-PARTY.md` (create if absent): "Connector glyphs: SimpleIcons project, CC0."
>
> **Unblocks:** `ConnectorBadgeRow` (marketplace simplification), `FlowSvg` node icons.
>
> **From:** wave 1 (ad1ecc6145d4df838).

---

> **`<DetailPageHeader>` shared component** — *Tier 3, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/components/DetailPageHeader.tsx` — new shared component
> - `dashboard/src/app/runs/[seq]/page.tsx` — adopt
> - `dashboard/src/app/sessions/[id]/page.tsx` — adopt
> - `dashboard/src/app/recipes/[...name]/page.tsx` — adopt where a header exists
>
> **Spec:** The current detail pages each implement their own header layout. Kilo's detail-page mockup *[wave 3 / a5667454168aa6931 chrome-only]* showed a clean three-row pattern that fits Patchwork's surfaces: breadcrumb → title row → meta row.
>
> Component shape:
>
> ```ts
> interface DetailPageHeaderProps {
>   breadcrumb?: Array<{ label: string; href?: string }>;
>   title: string;
>   statusBadge?: ReactNode;  // <StatusRing> or existing status pill
>   meta?: ReactNode;         // "Last run 4m ago · 47 runs · 1 halt"
>   actions?: ReactNode;      // right-aligned action zone
> }
> ```
>
> **Visual:** breadcrumb 13/400 `var(--ink-3)` separated by ` › `. Title 22/600 `var(--ink-1)`. Status badge inline after title with 12px gap. Meta line 13/400 `var(--ink-2)` below. Actions absolutely-positioned top-right of the header, 32px button height, 8px gap.
>
> The runs detail action zone (Rerun / Cancel / Copy URL) and the sessions detail action zone (End / Export / Save note) both render in this slot. The sticky failure banner from the existing Detail Page Improvements item sits BELOW the header.
>
> Pure additive — existing detail pages keep all their content; just rehoused into a consistent header shell.
>
> **Unblocks:** detail-page consistency; future detail surfaces (e.g. `/recipes/[name]`) get a free header pattern.
>
> **From:** wave 3 (a2fb3adcbf3239ca9, a5667454168aa6931 chrome-only).

---

> **Top-bar breadcrumb (wayfinding)** — *Tier 3, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/components/TopBarBreadcrumb.tsx` — new component
> - `dashboard/src/components/Shell.tsx` — mount in the topbar between brand-mark and existing action icons
> - `dashboard/src/lib/navRoutes.ts` — augment with `breadcrumbLabel` where the display label differs from the nav label
>
> **Spec:** Kilo's topbar carries a single breadcrumb (`Home`, or `Kilo › Leo · Lead Qualification Specialist` on detail pages) *[wave 3 / a2fb3adcbf3239ca9, a5667454168aa6931 chrome-only]*. Patchwork's topbar today carries bell + menu + theme-toggle (all retained) but no current-location indicator.
>
> Add a small left-aligned breadcrumb component derived from the current route + `NAV_SECTIONS`:
> - `/recipes` → "Recipes"
> - `/recipes/morning-brief/edit` → "Recipes › morning-brief › Edit"
> - `/runs/47` → "Runs › #47"
>
> Visual: 13/500 `var(--ink-2)`, separator ` › ` 13/400 `var(--ink-3)`, last segment 13/600 `var(--ink-1)`. Truncate middle segments with ellipsis when total width > 320px. Each non-terminal segment is a link to its route.
>
> The `<DetailPageHeader>` breadcrumb on detail pages mirrors this; the topbar version is always on every page so the user can confirm location without scanning the sidebar.
>
> Additive only — bell, menu, theme-toggle, command-palette trigger all remain.
>
> **Unblocks:** wayfinding for deep links (especially from external apps / Discord shares); reduces need to scan the sidebar to confirm location.
>
> **From:** wave 3 (a2fb3adcbf3239ca9, a5667454168aa6931 chrome-only).

---

> **`<ContextRail>` slot for wide-screen detail pages** — *Tier 3, leverage: medium, effort: medium*
>
> **Files:**
> - `dashboard/src/components/ContextRail.tsx` — new slot component
> - `dashboard/src/app/recipes/[...name]/page.tsx` — opt in
> - `dashboard/src/app/runs/[seq]/page.tsx` — opt in
> - `dashboard/src/app/sessions/[id]/page.tsx` — opt in
>
> **Spec:** Kilo's detail-page mockup uses a right rail (~26% of viewport width) for live context adjacent to the main content *[wave 3 / a5667454168aa6931 chrome-only]*. Patchwork's detail pages currently have empty whitespace on wide screens (≥1280px viewport).
>
> Layout: main content 70% width, `<ContextRail>` 30% width, sticky-top. Collapses to below-the-main-content stacked at `<1024px`; hidden at `<768px`.
>
> Context contents per surface:
>
> | Page | Rail contents |
> |---|---|
> | `/recipes/[name]` | Recent runs (last 5 with status + relative time), related sessions, "Watching for" trigger summary |
> | `/runs/[seq]` | Link to recipe definition, link to session, halt-history for this recipe (last 5 halts) |
> | `/sessions/[id]` | Recipes run in this session, related approvals, handoff note if present |
>
> Each rail item is a small card (12px radius, `var(--bg-1)` bg, 1px `var(--line-2)` border, 16px padding). Section labels small-caps `12/600 var(--ink-3)`.
>
> Pure addition. Detail page main content unchanged. Rail collapses gracefully on narrow viewports.
>
> **Unblocks:** context-rich detail pages without restructuring main content; foundation for future "Related runs" / "Related approvals" surfaces.
>
> **From:** wave 3 (a5667454168aa6931 chrome-only).

---

> **Auto-save indicator on `RecipeFormView`** — *Tier 3, leverage: low, effort: small*
>
> **Files:**
> - `dashboard/src/app/recipes/[...name]/_edit/_components/RecipeFormView.tsx` — add header save-state pill
>
> **Spec:** Kilo's workflow page header surfaces "Edited 15 minute ago" + an undo affordance *[wave 3 / a830b244ab0aaf68f]*. Patchwork's `RecipeFormView` saves to YAML in the underlying file system but offers no visible trust signal in the editor header.
>
> Add a small pill next to the page title showing one of:
>
> | State | Visual |
> |---|---|
> | No unsaved changes | `✓ Saved · 2m ago` — `var(--ok)` dot + relative time |
> | Buffered changes | `● Unsaved` — `var(--warn)` dot |
> | Save in flight | `↻ Saving…` — `var(--ink-3)` dot + spinner |
> | Last save errored | `⚠ Save failed — retry` — `var(--err)` dot, click to retry |
>
> Visual: 12/500, 4px–6px–8px padding, 999px radius, colored dot + label. Status colors compose from existing `--ok`, `--warn`, `--err`, `--ink-3` tokens — no new hex.
>
> Computed from existing save-state machinery — no new persistence required. The trust signal IS the value.
>
> **Unblocks:** users trust the editor; reduces "did my edit actually save?" anxiety, especially on slow disks.
>
> **From:** wave 3 (a830b244ab0aaf68f).

---

### Tier 4 — Motion + mobile + polish

Five items. All ship independently; none blocks Tier 1–3. Order within tier is by visible leverage.

---

> **Motion adds — slideInRight + freshFlash + FLIP** — *Tier 4, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — define `@keyframes slideInRight` and `@keyframes freshFlash`
> - `dashboard/src/components/LiveRunsStrip.tsx` — apply `slideInRight` to new cards
> - `dashboard/src/components/ActivityTicker.tsx` — apply `freshFlash` to new rows
> - `dashboard/src/components/RecipeLeaderboard.tsx` — add FLIP rank-change animation
>
> **Spec:**
>
> ```css
> @keyframes slideInRight {
>   from { opacity: 0; transform: translateX(24px); }
>   to   { opacity: 1; transform: translateX(0); }
> }
> @keyframes freshFlash {
>   0%   { background: color-mix(in srgb, var(--accent-cool) 30%, transparent); }
>   100% { background: transparent; }
> }
> ```
>
> - **LiveRunsStrip new cards**: 320ms `slideInRight` with `var(--ease-out)`.
> - **ActivityTicker new rows**: 600ms `freshFlash`. Use a `key` change + `useLayoutEffect` to add/remove a `.fresh` class.
> - **RecipeLeaderboard FLIP**: when re-sorted, animate rows from previous Y to new Y over 320ms with `var(--ease-out)`. Pure FLIP technique (~30 LOC of effect hook):
>   1. Before render: record each row's `getBoundingClientRect().top`.
>   2. After render: read new top; apply `transform: translateY(<old - new>px)` instantly.
>   3. Next frame: clear transform with transition.
>
> No library needed. Existing 14+ CSS keyframes in `globals.css` prove the team can ship this without framer-motion.
>
> Respect `prefers-reduced-motion: reduce` — wrap motion blocks in `@media (prefers-reduced-motion: no-preference)` or set `animation-duration: 0ms` under reduced motion.
>
> **Unblocks:** live surfaces look live without overwhelming the eye.
>
> **From:** wave 2 (a6c1ac511eaa61090).

---

> **Page-mount stagger** — *Tier 4, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — add `.overview-card` rule (existing `fadeInUp` keyframe is already there)
> - `dashboard/src/app/page.tsx` — add `style={{ '--i': i }}` to each home panel
>
> **Spec:** Stagger top-level home panels via the `--i` index variable.
>
> ```css
> .overview-card {
>   opacity: 0;
>   animation: fadeInUp 400ms var(--ease-out) forwards;
>   animation-delay: calc(var(--stagger-row) * var(--i, 0));
> }
> ```
>
> Apply to: `QuiltHero`, `NeedsAttentionBand`, `LiveRunsStrip`, Telemetry strip, `RecipesAtAGlance`, `RecipeLeaderboard`. The existing `fadeInUp` keyframe already in `globals.css` provides the up-direction; the new piece is the per-child delay.
>
> Same pattern on `/recipes`, `/runs`, `/marketplace` top-of-page grids — index each item with `--i`.
>
> **Unblocks:** page mounts have rhythm instead of a wall of fades.
>
> **From:** wave 2 (a6c1ac511eaa61090).

---

> **Mobile dashboard PWA polish** — *Tier 4, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/app/layout.tsx` — add meta tags
> - `dashboard/public/apple-touch-startup-image-*.png` — generate 6–8 splash screens
> - `dashboard/src/components/PushEnableCard.tsx` — new component
> - `dashboard/src/app/approvals/page.tsx` — mount `<PushEnableCard>` after first approval action
>
> **Spec:**
>
> 1. Add `<meta name="apple-mobile-web-app-title" content="Patchwork" />` to `layout.tsx`.
> 2. Generate 6–8 `apple-touch-startup-image-*.png` splash screens at standard iPhone resolutions (1170×2532, 1284×2778, 1290×2796, 1242×2688, 1125×2436, 1170×2532, etc.). One Sharp script generates all sizes from a single source SVG.
> 3. Add corresponding `<link rel="apple-touch-startup-image" media="..." href="...">` entries in `layout.tsx`.
> 4. `<PushEnableCard>`: surfaces on `/approvals` after the user's first approve/deny action (gated by a localStorage counter). Copy: "Get a push when an approval needs you. [Enable] [Later]". Wires to existing VAPID plumbing. Post-action consent timing — never prompt on first visit.
>
> **Unblocks:** install-to-home-screen on iOS feels native; push consent rate increases.
>
> **From:** wave 2 (aab786f1adb666306).

---

> **Mobile tap-target audit** — *Tier 4, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/components/Shell.tsx` — promote `mobile-menu-btn` 44px sizing unconditionally below 768px
> - `dashboard/src/components/Shell.tsx` (top bar) — replace hidden-on-mobile search button with icon-only 44×44 button
>
> **Spec:**
>
> 1. `mobile-menu-btn` in `Shell.tsx` currently sizes to 44px only via a `@media (pointer: coarse)` query. Promote to a hard `@media (max-width: 768px)` rule so iPads in landscape (with mouse) also hit the target.
> 2. The top-bar search button is currently `display: none` below 768px. Replace with an icon-only `<button>` 44×44 (12×12 search SVG centered) that opens the existing command palette. Without this, mobile users have no keyboard-free path to search.
>
> Audit pass: any interactive element under 44×44 in viewports < 768px is a bug. Common offenders: chevrons, close `×` buttons, segmented-control segments. Pad the hit area without changing visual size where needed (`padding: 12px; margin: -12px;` pattern).
>
> **Unblocks:** mobile users can reach search and nav without zooming.
>
> **From:** wave 2 (aab786f1adb666306).

---

> **`RecipeFormView` polish — drag-to-reorder + group labels** — *Tier 4, leverage: low, effort: small*
>
> **Files:**
> - `dashboard/src/app/recipes/[...name]/_edit/_components/RecipeFormView.tsx` — replace ▲/▼ buttons with HTML5 drag handle; add auto-derived group labels
>
> **Spec:** ~40 LOC drag-and-drop + ~20 LOC group label derivation. Native HTML5 drag events, no library.
>
> **Drag-to-reorder:** add a 24×40 drag handle (six-dots glyph) on the left of each step card. Reorder mutates the in-memory step array; YAML serialization downstream reflects the new order. Replaces existing ▲/▼ buttons.
>
> **Auto-derived group labels:** scan consecutive steps for matching `step.tool` connector namespaces. If 2+ consecutive steps use `gmail.*` tools, render a thin "Gmail" capsule (12/600 caps `var(--ink-3)`, `var(--bg-2)` background, 999px radius) above the run.
>
> Group labels are pure cosmetic — not persisted, not part of the YAML, recomputed on every render.
>
> **Unblocks:** small ergonomic win for users iterating on a multi-step recipe.
>
> **From:** wave 2 (a761afdb21bbfe303).

---

> **Sidebar section-title small-caps treatment** — *Tier 4, leverage: low, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — add `.sidebar-section-title` rule
> - `dashboard/src/components/Shell.tsx` — apply class to each `section.title` render
>
> **Spec:** `NAV_SECTIONS` in `dashboard/src/lib/navRoutes.ts` already groups nav items under titled sections — the JSX in `Shell.tsx` reads `section.title` and `section.items`. Kilo's sidebar uses small-caps eyebrows (`MENU`, `PROJECTS`) at 11/600 with letter-spacing 0.6px to delineate groups *[wave 3 / a2fb3adcbf3239ca9]*.
>
> Ensure each `section.title` renders with this treatment:
>
> ```css
> .sidebar-section-title {
>   font-size: 11px;
>   font-weight: 600;
>   text-transform: uppercase;
>   letter-spacing: 0.6px;
>   color: var(--ink-3);
>   padding: 16px 16px 6px;
>   user-select: none;
> }
> ```
>
> Pure visual polish — section grouping already exists in the nav structure; this normalizes the visual treatment of the titles.
>
> **Unblocks:** sidebar visual rhythm; sections read as groups instead of one long list.
>
> **From:** wave 3 (a2fb3adcbf3239ca9).

---

> **Section header count badges** — *Tier 4, leverage: medium, effort: small*
>
> **Files:**
> - `dashboard/src/components/SectionCountBadge.tsx` — new small pill component
> - `dashboard/src/app/page.tsx` — apply to "Recipes" + "Recent runs" headers
> - `dashboard/src/app/recipes/page.tsx` — apply to the page H1
> - `dashboard/src/app/runs/page.tsx` — apply
> - `dashboard/src/app/activity/page.tsx` — apply
> - `dashboard/src/app/approvals/page.tsx` — apply
>
> **Spec:** Kilo surfaces a small count badge next to list-y section titles ("Your Agents `9`") *[wave 3 / a2fb3adcbf3239ca9]*. Patchwork's nav items already carry approval / halts / runs badges via `Shell.tsx`; the corresponding section titles don't.
>
> Visual: inline-flex pill, 20px min-width, height 20px, padding 0 6px, `color-mix(in srgb, var(--ink-1) 8%, transparent)` bg, `var(--ink-2)` text, 11/600, 999px radius, 8px gap from preceding title text. Render nothing when count = 0 (don't show "0").
>
> Applications:
>
> | Surface | Badge |
> |---|---|
> | Home — "Recipes" header | total installed recipe count |
> | Home — "Recent runs" header | runs in last 24h |
> | Recipes hub | total recipe count |
> | Activity | "events today" |
> | Approvals | pending count |
>
> Pure additive — section titles unchanged; counts come from existing data hooks.
>
> **Unblocks:** at-a-glance scale-of-content cues throughout the dashboard without adding any new data fetches.
>
> **From:** wave 3 (a2fb3adcbf3239ca9).

---

> **`<StatusRing>` — ringed-icon status variant (additive to pills)** — *Tier 4, leverage: low, effort: small*
>
> **Files:**
> - `dashboard/src/components/StatusRing.tsx` — new component
>
> **Spec:** Kilo column headers use ringed status icons (`○ Draft 4` gray ring, `⏸ Paused 2` orange ring, `▶ Active 24` green ring) *[wave 3 / a2fb3adcbf3239ca9]*. Patchwork uses text pills today — also valuable, since text labels are accessible.
>
> Add `<StatusRing>` as a NEW additive variant — not a replacement. Existing pills stay everywhere they're used. New surfaces (e.g. column headers in any future grouped views, future recipe lifecycle dashboards) opt in.
>
> Component shape:
>
> ```ts
> type StatusKind = "ok" | "warn" | "err" | "running" | "paused" | "draft";
> interface StatusRingProps {
>   kind: StatusKind;
>   label?: string;
>   count?: number;
> }
> ```
>
> Visual: 16×16 SVG circle, 2px stroke in the kind's token color, glyph centered (✓ ok, ⏸ paused, ● running, ○ draft, ! err, ⚠ warn). Label + count optional inline beside the ring.
>
> Kind → token:
>
> | Kind | Token |
> |---|---|
> | ok | `var(--ok)` |
> | warn | `var(--warn)` |
> | err | `var(--err)` |
> | running | `var(--accent-cool)` |
> | paused | `var(--ink-2)` |
> | draft | `var(--ink-3)` |
>
> All glyphs from existing icon set or inline SVG paths. No new icon library.
>
> **Unblocks:** new visual vocabulary for lifecycle states without disturbing existing status surfaces.
>
> **From:** wave 3 (a2fb3adcbf3239ca9).

---

> **`StatCard` value-size hierarchy bump** — *Tier 4, leverage: low, effort: small*
>
> **Files:**
> - `dashboard/src/app/globals.css` — refine `.stat-card-value` rule
> - `dashboard/src/components/StatCard.tsx` — no JSX change required
>
> **Spec:** Kilo's main dashboard mockup makes the stat number the largest element on its card (~36px) with delta caption + label as supporting text *[wave 3 / a2fb3adcbf3239ca9]*. Patchwork's `.stat-card-value` is currently smaller; the existing `StatCard` already supports a `delta` prop (`DeltaBadge` renders inline) — visual hierarchy just needs strengthening.
>
> Bump `.stat-card-value` to:
>
> ```css
> .stat-card-value {
>   font-size: clamp(28px, 4vw, 36px);
>   line-height: 1;
>   font-weight: 600;
>   letter-spacing: -0.5px;
> }
> ```
>
> Keep `.stat-card-label` and `.stat-card-foot` unchanged. `DeltaBadge` already renders inline-baseline with the value — no change needed there.
>
> Visual change only; `StatCard` JSX, props, and existing `delta` / `icon` / `foot` slots all stay.
>
> **Unblocks:** dashboard scan-ability improves; numbers read first, labels second.
>
> **From:** wave 3 (a2fb3adcbf3239ca9).

---

## Patterns to skip — and why

Each entry: one sentence of why. Three categories.

### Skip to preserve developer audience

- **Bouncy easings on UI elements** — measured entry motion *[wave 2 / a6c1ac511eaa61090]* is `cubic-bezier(0.16, 1, 0.3, 1)` with no overshoot; reserve `back.out` springs for explicit celebration moments, not row entries.
- **Auto-counting stat numbers** — Patchwork's numbers are real telemetry; animating them misleads. Static numbers with real `+2 this week` deltas signal honesty.

### Skip to preserve local-first / OSS posture

- **Demo mode with fake recipes/runs** — *[wave 2 / ac747695d1ae3248d]* explicitly rejected: contradicts the "your data, your laptop" pitch.
- **Faux-AI confidence in run status** — "Done!" badges when a run was really halted; surface the real status with the real color.

### Skip to preserve dashboard signal

- **Confetti / celebration animations** — `freshFlash` is the celebration vocabulary; confetti steals from real data.
- **Bar-chart sparklines** — *[wave 3 / a2fb3adcbf3239ca9]*: Patchwork's existing line-style sparklines convey trend more honestly without quantizing into bins.
- **`ToolCallsWidget` + `EntityTimeline` + `ActivityThread` on the home page** — *[wave 3 / a2fb3adcbf3239ca9]*: move to `/activity`; home is a directory, not a stream.
- **Auto-rotating carousels anywhere** — steal attention from live data.
- **Scroll-snap** — breaks native scroll velocity; mounting stagger is sufficient.

### Reject as dependency

- **framer-motion** — existing CSS keyframes (14+) prove sufficient; bundle cost not justified by row entry, FLIP, and flash use cases.
- **Heavy node-canvas editor library (React Flow, etc.)** — Relay.app's choice of a vertical list over a node canvas is the proof; `FlowSvg` is pure SVG, ~250 LOC, no dependencies.

---

## Design token reference

Drop into `dashboard/src/app/globals.css`. Existing tokens unchanged; new ones additive.

### Showcase dark theme (opt-in `[data-theme="showcase"]`)

```css
[data-theme="showcase"] {
  --canvas: #0a0a0a;
  --surface: #121212;
  --recess: #1f1f1f;
  --bg-0: #0a0a0a;
  --bg-1: #121212;
  --bg-2: #1f1f1f;
  --bg-3: #2a2a2a;
  --raised: #2a2a2a;
  --ink-1: #ffffff;
  --ink-2: #a1a1a1;
  --ink-3: #737373;
  --line-1: #2a2a2a;
  --line-2: #1f1f1f;
  --accent: #0787ff;
  --accent-pill-bg: #041233;
  --accent-pill-ink: #0787ff;
  --r-sm: 10px;
  --r-md: 12px;
  --r-hero: 24px;
  --r-pill: 999px;
  --shadow-cta-primary:
    inset 0 1px 0 1px rgba(255,255,255,0.3),
    0 6px 12px rgba(43,149,255,0.3);
  --glow-icon: 0 0 8px #0787ff;
}
```

### Cool accent additions (global, not theme-gated)

```css
:root {
  --accent-cool: #0787ff;
  --accent-cool-glow: rgba(7,135,255,0.3);
  --r-hero: 24px;
  --glow-icon: 0 0 8px var(--accent-cool);
  --hover-bg: color-mix(in srgb, var(--ink-1) 4%, transparent);
}
```

Reserved usage:
- FlowSvg "running" status badge stroke + fill mix.
- Selected sidebar item glow.
- Sparkline stroke on stat cards.
- Connector `+N` overflow pill text.

Do NOT use for primary CTAs (those stay orange `var(--accent)` on default cream theme) or destructive actions.

### Motion vocabulary

```css
:root {
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --motion-fast: 180ms;
  --motion-base: 320ms;
  --motion-slow: 1000ms;
  --stagger-row: 60ms;
}
```

translateY palette: `10 / 12 / 24 / 32 / 40 / 72 px` *[wave 2 / a6c1ac511eaa61090]*. Default row-entry distance: **24px**. scale(0.6) reserved for emphasis-on-appearance.

Standard entry pattern:

```css
.overview-card {
  opacity: 0;
  animation: fadeInUp 400ms var(--ease-out) forwards;
  animation-delay: calc(var(--stagger-row) * var(--i, 0));
}
```

### Display heading variant

```css
.editorial-h1.display {
  font-size: clamp(40px, 6vw, 56px);
  line-height: 1;
  letter-spacing: -1.5px;
  font-weight: 600;
}
```

Use on `dashboard/src/app/marketplace/page.tsx` hero block and any future presentation surfaces. The default `.editorial-h1` (`clamp(22px, 2.4vw, 30px)`) stays the in-app standard.

### Status color mapping (FlowSvg + run UI)

| Status | Badge fill | Badge stroke | Glyph |
|---|---|---|---|
| ok | `color-mix(in srgb, var(--ok) 20%, var(--bg-1))` | `var(--ok)` | ✓ |
| error | `color-mix(in srgb, var(--err) 25%, var(--bg-1))` | `var(--err)` | ! |
| running | `color-mix(in srgb, var(--accent-cool) 20%, var(--bg-1))` | `var(--accent-cool)` | ◍ rotating |
| pending | `var(--bg-1)` | `var(--line-2)` | ⋯ |
| skipped | `var(--bg-2)` | `var(--ink-3)` | − |

All five reuse existing Patchwork tokens. No new hex literals introduced.

---

## File inventory

Every file path called out across the brief, grouped by surface.

### Dashboard — new files to create

| Path | Purpose |
|---|---|
| `dashboard/src/components/RecipeHubCard.tsx` | Recipes hub card (Tier 2) |
| `dashboard/src/components/MarketplaceTrustTooltip.tsx` | Tooltip behind the trust info icon on marketplace cards (Tier 2) |
| `dashboard/src/components/ConnectorBadgeRow.tsx` | First-2-plus-N connector display (Tier 2) |
| `dashboard/src/app/recipes/[...name]/_edit/_components/FlowSvg.tsx` | Read-only SVG flow viz (Tier 2) |
| `dashboard/src/app/recipes/[...name]/_edit/_components/flowLayout.ts` | Pure layout (rank + stack) (Tier 2) |
| `dashboard/src/components/PushEnableCard.tsx` | Post-first-approval Web Push prompt (Tier 4) |
| `dashboard/src/components/DetailPageHeader.tsx` | Shared header (breadcrumb + title + status + meta + actions) for detail pages (Tier 3) |
| `dashboard/src/components/TopBarBreadcrumb.tsx` | Topbar wayfinding component (Tier 3) |
| `dashboard/src/components/ContextRail.tsx` | Right-rail slot for wide-screen detail pages (Tier 3) |
| `dashboard/src/components/SectionCountBadge.tsx` | Small inline count pill for section headers (Tier 4) |
| `dashboard/src/components/StatusRing.tsx` | Ringed-icon status variant, additive to existing pills (Tier 4) |

### Dashboard — existing files to modify

| Path | Change |
|---|---|
| `dashboard/src/app/globals.css` | Add `[data-theme="showcase"]` block (including `--bg-3` / `--raised`); cool accent globals (including `--hover-bg`); motion tokens; `slideInRight` + `freshFlash` keyframes; `.editorial-h1.display`; `.overview-card` stagger rule; `.sidebar-section-title` small-caps rule; bumped `.stat-card-value` size |
| `dashboard/src/app/layout.tsx` | Move `FirstRunChecklist` here; add `apple-mobile-web-app-title` meta + apple-touch-startup-image links |
| `dashboard/src/app/page.tsx` | Remove `ToolCallsWidget`, `EntityTimeline + ActivityThread` grid; gate Telemetry on zero data; reorder home; add `--i` stagger index on each panel; mount `<SectionCountBadge>` on Recipes + Recent runs headers |
| `dashboard/src/app/activity/page.tsx` | Mount `<SectionCountBadge>` on the events header |
| `dashboard/src/app/approvals/page.tsx` | Mount `<SectionCountBadge>` on pending header; mount `<PushEnableCard>` after first action |
| `dashboard/src/app/recipes/[...name]/page.tsx` | Adopt `<DetailPageHeader>`; opt into `<ContextRail>` (recent runs + related sessions + trigger summary) |
| `dashboard/src/lib/navRoutes.ts` | Augment with optional `breadcrumbLabel` where display label differs from nav label |
| `dashboard/src/app/marketplace/page.tsx` | Simplify `RecipeCard`: trust tooltip + ConnectorBadgeRow + bigger Install; new empty state copy; apply `.editorial-h1.display` to hero |
| `dashboard/src/app/recipes/page.tsx` | Add Cards/List toggle; replace table with grid on Cards view; force Cards on mobile < 768px; new empty state copy |
| `dashboard/src/app/runs/page.tsx` | New empty state copy + primary CTA |
| `dashboard/src/app/sessions/page.tsx` | Tighten empty state copy; remove passive Refresh button |
| `dashboard/src/app/runs/[seq]/page.tsx` | Sticky failure banner; auto-expand failed steps; collapse successful steps; top-right action zone (Rerun / Cancel / Copy URL); add Flow tab; adopt `<DetailPageHeader>`; opt into `<ContextRail>` (recipe link + session link + halt history) |
| `dashboard/src/app/sessions/[id]/page.tsx` | Sticky failure banner; top-right action zone; adopt `<DetailPageHeader>`; opt into `<ContextRail>` (recipes run + approvals + handoff note) |
| `dashboard/src/app/recipes/[...name]/_plan/page.tsx` | Add `[Flow] [Table]` toggle, default Flow when steps ≤ 12 |
| `dashboard/src/app/recipes/[...name]/_edit/page.tsx` | Wire YAML deep-link from FlowSvg node click (hash-based scroll) |
| `dashboard/src/app/recipes/[...name]/_edit/_components/RecipeFormView.tsx` | Drag-to-reorder steps; auto-derived group labels from connector namespaces; auto-save indicator pill in the editor header |
| `dashboard/src/app/approvals/page.tsx` | Mount `<PushEnableCard>` after first approval action |
| `dashboard/src/components/Shell.tsx` | Unconditional 44px `mobile-menu-btn` < 768px; replace hidden search button with icon-only 44×44; mount `<TopBarBreadcrumb>` in topbar; apply `.sidebar-section-title` class to each `NAV_SECTIONS` title |
| `dashboard/src/components/LiveRunsStrip.tsx` | Apply `slideInRight` on new cards |
| `dashboard/src/components/ActivityTicker.tsx` | Apply `freshFlash` to new rows |
| `dashboard/src/components/RecipeLeaderboard.tsx` | Add FLIP rank-change animation |

### Bridge / recipe schema — modifications

**None.** Recipe schema is unchanged. No `display:` block, no new YAML fields. The overhaul is dashboard-only.

### Asset directories — connector glyphs only

| Path | Purpose |
|---|---|
| `dashboard/public/connectors/NOTICE.md` | SimpleIcons attribution + trademark disclaimer (CC0 1.0 Universal) |
| `dashboard/public/connectors/gmail.svg` | SimpleIcons brand glyph, 24×24 viewBox, `fill="currentColor"` |
| `dashboard/public/connectors/google-calendar.svg` | SimpleIcons (renamed from `googlecalendar.svg`) |
| `dashboard/public/connectors/google-drive.svg` | SimpleIcons (renamed from `googledrive.svg`) |
| `dashboard/public/connectors/linear.svg` | SimpleIcons |
| `dashboard/public/connectors/github.svg` | SimpleIcons |
| `dashboard/public/connectors/slack.svg` | SimpleIcons |
| `dashboard/public/connectors/asana.svg` | SimpleIcons |
| `dashboard/public/connectors/discord.svg` | SimpleIcons |
| `dashboard/public/connectors/gitlab.svg` | SimpleIcons |
| `dashboard/public/connectors/jira.svg` | SimpleIcons |
| `dashboard/public/connectors/confluence.svg` | SimpleIcons |
| `dashboard/public/connectors/notion.svg` | SimpleIcons |
| `dashboard/public/connectors/hubspot.svg` | SimpleIcons |
| `dashboard/public/connectors/sentry.svg` | SimpleIcons |
| `LICENSE-THIRD-PARTY.md` (repo root) | Add (or create): "Connector glyphs: SimpleIcons project, CC0." |
| `dashboard/public/apple-touch-startup-image-*.png` | 6–8 iPhone splash screens generated by Sharp script |

---

## Provenance

### Mining waves

| Wave | Date | Coverage |
|---|---|---|
| Wave 1 | 2026-05-22 to 2026-05-23 | Visual language, component patterns, IA + copy |
| Wave 2 | 2026-05-23 to 2026-05-24 | Motion, mobile + PWA, onboarding funnels, workflow editor (n8n + Relay.app comparative) |
| Wave 3 | 2026-05-24 to 2026-05-25 | Main dashboard mockups + workflow page pixel spec |

### Resumable agents (still available if needed)

Dashboard-relevant agents. Persona-track agents (ab4ac8337a02a5127, a5667454168aa6931) are no longer load-bearing under the dashboard-only scope and have been removed from the active set.

| Agent ID | Wave | Domain | Status |
|---|---|---|---|
| aeecad115cd19b2f3 | 1 | Visual language tokens (showcase theme, cool accent) | Available |
| a6c1ac511eaa61090 | 2 | Motion (ease-out, slideInRight, freshFlash, FLIP) | Available |
| aab786f1adb666306 | 2 | Mobile + PWA (tap targets, splash screens, push consent) | Available |
| ac747695d1ae3248d | 2 | Onboarding (FirstRunChecklist move, empty states) | Available |
| a761afdb21bbfe303 | 2 | Workflow editor (Relay.app, vertical list, RecipeFormView polish) | Available |
| a830b244ab0aaf68f | 3 | Workflow page pixel spec (FlowSvg) | Available |
| a2fb3adcbf3239ca9 | 3 | Main dashboard (home tightening, detail page improvements, sparklines) | Available |

If a section of this brief reveals an open question that a wave didn't measure (notably: exact pixel coordinates for the failure banner, the on-disk format for connector glyphs after the cleanup pass, motion timing for the FLIP transition), the originating agent is the right resume target.

### Screenshots saved

Baseline references in `.playwright-mcp/`:

- `patchwork-dashboard-home-current.png` — baseline for home tightening
- `patchwork-recipes-hub-current.png` — baseline for hub table-to-cards
- `patchwork-marketplace-current.png` — baseline for marketplace simplification
- `patchwork-run-detail-current.png` — baseline for detail page improvements

Competitive references kept for visual cross-check:

- `relay-vertical-list.png` — Relay.app comparative (the decisive "billion-dollar competitor chose vertical list" finding for FlowSvg read-only stance)
- `n8n-canvas.png` — n8n comparative (the contrasting node-canvas approach that was rejected)

---

## Notes for implementing agents

This brief is meant to be read top-to-bottom once, then referenced item-by-item during implementation. A few load-bearing conventions:

- Wave references in italics `*[wave N / agentID]*` point at the originating agent if you need a deeper measurement than this brief captured. Resume that agent rather than re-mining.
- Every Tier item lists its **Files** and its **Unblocks**. If you're picking up an item, also pull up its unblocked downstream items so the contract between them is fresh in your head.
- Use the existing Patchwork tokens (`--bg-0`, `--bg-1`, `--ink-1`, `--ok`, `--err`, `--accent`) wherever possible. New tokens are listed exhaustively in the design token reference section; if you find yourself reaching for a hex literal in a component, stop and check whether the value should be a token.
- The Patterns to Skip section is a hard-rejection list. If you find yourself implementing one of those patterns for "just a moment", surface the trade-off in PR review.
- Run `npx biome check --write` on every changed file before staging. Type errors should be caught by `getDiagnostics` before `npm run build`.

End of brief.

---

## Changelog

- 2026-05-25 — Initial synthesis (3 mining waves, 11 agents).
- 2026-05-25 — Revised: scoped to dashboard-only; landing-site work and the named-agent persona system dropped. Persona library, portrait art direction, AgentAvatar/AgentCard/AgentConstellation/RecipeRoster, chat-first new-recipe redesign, and all `landing/` work removed. FlowSvg, recipes hub Cards/List toggle, marketplace simplification, home page tightening retained as Tier 2.
- 2026-05-25 — Additive mining pass: 10 items added across Tiers 1/3/4, no removals. New tokens (`--bg-3`/`--raised`, `--hover-bg`). New components (`<DetailPageHeader>`, `<TopBarBreadcrumb>`, `<ContextRail>`, `<SectionCountBadge>`, `<StatusRing>`). New polish: sidebar section-title small-caps, `RecipeFormView` auto-save indicator, `StatCard` value-size hierarchy bump. Every addition preserves existing functionality — no replacements.
