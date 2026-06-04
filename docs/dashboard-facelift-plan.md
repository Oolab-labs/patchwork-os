> Source: live UI inspection (Overview / Runs / Traces) on 2026-06-04, grounded in code by a multi-agent pass (exact file:line + token targets) and reconciled with the original facelift plan in [audit-2026-06-03.md](audit-2026-06-03.md). Supersedes the facelift section there.
>
> Keystone: the color-token grammar PR (P0) cascades into the error-color (P0-2) and status-pill (P0-3) fixes — do it first.

# Dashboard Facelift Plan — v2

## Foundered first: the color-token grammar

This is the keystone. Every other fix either flows from or is blocked by this PR.

### New/corrected token values (globals.css :root and dark-mode blocks)

**Light mode :root additions and corrections**

```css
/* Darken --ink-3 by 4 lightness points — fixes 10px label contrast from 4.31→4.65:1 */
--ink-3: #706550;           /* was #7a6f57 */

/* Pill text variants — separate from status decoration tokens */
--ok-text: #3d6635;         /* 5.5:1 on --ok-soft (#eaf0e5) — replaces bare --ok in pill text */
--warn-text: #7a5200;       /* 5.8:1 on --warn-soft (#f6ecd3) */
--err-text: #aa3838;        /* 5.5:1 on --err-soft (#f5e0e0) */
```

**Dark mode [data-theme="dark"] additions**

```css
/* --err fails at 3.6:1 on dark canvas; no dark override existed */
--red: #d05757;             /* 4.86:1 on #0a0b0d, 4.63:1 on #101216 — PASSES AA */
--err: #d05757;
--red-soft: rgba(208,87,87,0.16);
```

No other new tokens. Every re-pointing below uses existing `--ok`, `--warn`, `--err`, `--accent-cool`, `--ink-2`, `--ink-3`, `--line-3`.

---

### Pill system fix (globals.css:1219–1325)

```css
/* Replace the three tone-pill rules */
.pill.ok   { background: var(--ok-soft);   color: var(--ok-text, #3d6635);   border-color: transparent; }
.pill.warn { background: var(--warn-soft); color: var(--warn-text, #7a5200); border-color: transparent; }
.pill.err  { background: var(--err-soft);  color: var(--err-text, #aa3838);  border-color: transparent; }

/* Add info pill (replaces .pill.accent for filter-active state) */
.pill.info { background: var(--blue-soft); color: var(--blue); border-color: transparent; }

/* Remove .pill.accent entirely — no longer a valid tone */
```

Dot color is `currentColor` — auto-corrects once text colors are fixed. No separate dot fix.

---

### Orange reservation: the complete re-pointing table

**Keep as `--accent` (orange) — legitimate uses only**

| Site | Role |
|---|---|
| `Shell.tsx:63-70` logo SVG | Brand identity |
| `globals.css:400` `.sidebar-create` | Primary CTA |
| `globals.css:998` `.btn.primary` | Primary CTA |
| `globals.css:496-499` `.app-nav-link.is-active::after` + icon | Active-nav indicator |
| `globals.css:347` `:focus-visible` outline | Functional focus ring |
| `globals.css:1187` `.input:focus` border | Functional form focus |
| `globals.css:855,872,910` card hover glow `rgba(var(--orange-rgb),0.2)` | Decorative warmth — acceptable |
| `globals.css:2301` `.editorial-h1 .accent` in Overview hero **only** | Brand tagline — scoped below |

**Re-point to `--accent-cool` (blue/info)**

| File:line | Current | Change to |
|---|---|---|
| `globals.css:800` `.global-live-runs-strip-bar > span` | `var(--accent)` | `var(--accent-cool)` |
| `globals.css:519` `.nav-badge` background | `var(--orange)` | `var(--info)` |
| `runs/page.tsx:891` duration bar fill | `var(--accent)` | `var(--accent-cool)` |
| `activity/page.tsx:614,618,627` active filter chip | `var(--accent)` | `var(--accent-cool)` |
| `traces/page.tsx:655,663,687` `.pill.accent` → | `.pill.accent` class | `.pill.info` class in JSX |
| `recipes/_plan/page.tsx:95` tool node | `var(--accent)` | `var(--accent-cool)` |
| `EntityTimeline.tsx:60` trace event | `var(--accent,#7c6ff7)` | `var(--accent-cool)` |
| `RelationStrip.tsx:57-59` (conditional) | `var(--accent)` | `var(--accent-cool)` when no halts |

**Re-point to `--ink-2` (neutral label)**

| File:line | Role |
|---|---|
| `approvals/[callId]/page.tsx:495` | Field label |
| `runs/[seq]/page.tsx:481,552` | Step count/sub-labels |
| `sessions/page.tsx:203` | Session label |
| `tasks/page.tsx:725,733` | Column headers |
| `transactions/page.tsx:195` | Field label |
| `recipes/_components/DoctorPanel.tsx:213` | Panel label |
| `recipes/_edit/page.tsx:1077` | Edit page label |
| `globals.css:5503` `.pg-section-head-bar` | Change to `var(--line-3)` — decorative divider |
| `globals.css:5442` `.attention-offline-link` | Change to `var(--info)` |

**Re-point to `--err`**

| File:line | Role |
|---|---|
| `decisions/page.tsx:416,418,421` "Problem" card | bg→`--err-soft`, border→`color-mix(in srgb, var(--err) 30%, transparent)`, text→`var(--err-text)` |

**Remove orange default from component props**

| File:line | Change |
|---|---|
| `Sparkline.tsx:15` `color = 'var(--orange)'` | Remove default; require callers to pass color |
| `HBarList.tsx:58` `?? var(--orange)` fallback | Change to `?? var(--ink-3)` |

**Scope `.editorial-h1 .accent` to Overview only (resolves P2-8 at the token level)**

```css
/* globals.css — narrow the orange rule */
.editorial-h1 .accent {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--ink-2);       /* neutral default on all data pages */
  letter-spacing: 0;
}
/* Orange only inside the overview hero */
.overview-hero .editorial-h1 .accent,
.quilt-content .editorial-h1 .accent {
  color: var(--orange);
}
```

Add class `overview-hero` to the quilt wrapper in `page.tsx` Overview section if not already present; then remove all `.accent` spans from `runs/page.tsx:477`, `traces/page.tsx:597`, `activity/page.tsx:425`, `analytics/page.tsx:182` (replace with factual neutral subtitle — see P2-8 fix items below).

---

## Prioritized fix list (P0 → P3)

### P0 — Must land before any other visual work

- [ ] **P0-1-A Token grammar PR** `globals.css :root` — add `--ok-text`, `--warn-text`, `--err-text`; darken `--ink-3`; dark-mode `--red`/`--err` override. Scope `.editorial-h1 .accent` orange to `.overview-hero` parent. Add `.pill.info` rule; remove `.pill.accent`. **Effort: small.** No deps.

- [ ] **P0-1-B Re-point running-strip bar** `globals.css:800` — `.global-live-runs-strip-bar > span { background: var(--accent-cool); }`. **Effort: trivial.** Deps: P0-1-A merged.

- [ ] **P0-1-C Re-point nav-badge** `globals.css:519` — `background: var(--info)`. **Effort: trivial.** Deps: P0-1-A.

- [ ] **P0-1-D Re-point section-head bar** `globals.css:5503` — `.pg-section-head-bar { background: var(--line-3); }`. **Effort: trivial.** Deps: P0-1-A.

- [ ] **P0-1-E Re-point activity filter chips** `activity/page.tsx:614,618,627` — replace three `var(--accent)` references with `var(--accent-cool)`. **Effort: trivial.** Deps: P0-1-A.

- [ ] **P0-1-F Re-point traces active filter pills** `traces/page.tsx:655,663,687` — change JSX from `.pill.accent` → `.pill.info`. **Effort: trivial.** Deps: P0-1-A (`.pill.info` must exist).

- [ ] **P0-1-G Re-point field labels to --ink-2** — seven files listed in the re-pointing table above. Each is a 1-line change. **Effort: small total.** Deps: P0-1-A.

- [ ] **P0-1-H Re-point Decisions "Problem" card** `decisions/page.tsx:416,418,421` — bg/border/text to err tokens. **Effort: trivial.** Deps: P0-1-A.

- [ ] **P0-1-I Sparkline default color** `Sparkline.tsx:15` — remove `color = 'var(--orange)'` default; audit all callers and pass explicit colors: runs→`var(--ok)`, halts→`var(--err)`, tools→`var(--accent-cool)`. `HBarList.tsx:58` fallback → `var(--ink-3)`. **Effort: small.** Deps: P0-1-A.

- [ ] **P0-1-J Re-point plan tool node** `recipes/_plan/page.tsx:95` — `var(--accent-cool)`. **Effort: trivial.** Deps: P0-1-A.

- [ ] **P0-2 Errored stat card background** `globals.css` — add:
  ```css
  .runs-stat-card[data-variant="error"] {
    background: color-mix(in oklch, var(--err) 5%, var(--card-bg, var(--bg-0)));
  }
  .runs-stat-card[data-variant="done"] {
    background: color-mix(in oklch, var(--ok) 5%, var(--card-bg, var(--bg-0)));
  }
  ```
  In `runs/page.tsx:697` change `⚠ Errored` label to `✗ Errored`. **Effort: small.** Deps: P0-1-A (dark-mode `--err` fix).

- [ ] **P0-3-A Pill text contrast fix** — applied via P0-1-A token additions (`--ok-text`, `--warn-text`, `--err-text`) and the pill CSS rule block update above. **Effort: covered by P0-1-A.** No extra file.

- [ ] **P0-3-B Running dot: remove duplicate JSX dot in desktop row** `runs/page.tsx:884-898` — delete the `<span style={{background:'var(--accent)',...}}/>` branch; let `.pill.running::before` CSS handle it. Same for mobile branch at 1075-1090. **Effort: small.** Deps: P0-1-A.

- [ ] **P0-3-C Unify `statusPill()` with `deriveRunStatus()`** `runs/page.tsx:111-120` — replace local function with call to `deriveRunStatus(r.status, {hadStepErrors, assertionFailures})` from `StatusPill.tsx`. Map `tone: "info"` → CSS class `info`. **Effort: small.** Deps: P0-3-B (class names must align).

- [ ] **P0-3-D Progress-fill default color** `globals.css` — change `.progress-fill { background: var(--ok); }` (was `var(--orange)`). **Effort: trivial.** Deps: P0-1-A.

---

### P1 — High-value UX fixes, second PR

- [ ] **P1-4 Sparkline labels on Tools-called tile** `page.tsx:1192-1202` — build `hours24Labels` string array alongside `curveSeries` loop; pass as `labels={hours24Labels} unit="calls"` to the Sparkline. Change runs sparkline `color` from `var(--accent)` → `var(--ok)` at line 1112. **Effort: small.** Deps: P0-1-I (Sparkline default removed).

- [ ] **P1-5-A Recipe display name in FeaturedRecipeAside** `FeaturedRecipeAside.tsx:221-229` — extract `ragDisplayName` to a shared util (e.g. `src/lib/recipeDisplay.ts`); import and apply in the `quilt-aside-name` Link and `title` attribute. **Effort: small.** Deps: none.

- [ ] **P1-5-B SuccessRing percentage suffix** `SuccessRing.tsx:70` — change `` `${Math.round(safePct)}` `` to `` `${Math.round(safePct)}%` ``; update `aria-label` at line 34 to `"${Math.round(safePct)}% ok rate"`. **Effort: trivial.** Deps: none.

- [ ] **P1-5-C FeaturedRecipeAside empty state** `FeaturedRecipeAside.tsx:151-166` — accept `recipesCount: number` prop from `page.tsx` (where `recipes.length` is available); show `"${recipesCount} recipe${recipesCount===1?'':'s'} installed"` or `"No recipes yet"`. **Effort: small.** Deps: none.

- [ ] **P1-6 Duration column aria-label + default color** `runs/page.tsx:906-924` — add `aria-label={`Duration: ${fmtDur(r.durationMs)}, status: ${statusLabel(r)}`}` on the `<td>`. Default fill already fixed by P0-3-D. **Effort: trivial.** Deps: P0-3-D.

- [ ] **P1-7 NeedsAttentionBand item order + severity** `page.tsx:318-337,378-395` and `globals.css:5418-5478`:
  - Swap items array: approvals → failed runs → halts.
  - Add `severity` field; derive `bandSeverity = items.some(i=>i.urgent) || failingCount24h > 0 ? 'err' : 'warn'`.
  - In `globals.css` add `.attention-band--err` variant with `var(--err)` border/bg tints.
  - Add `attention-chip--err` CSS class with stronger err bg tint; apply to failing-runs chip.
  - **Effort: small.** Deps: P0-1-A (err tokens).

---

### P2 — Polish, second or third PR depending on bandwidth

- [ ] **P2-8-A Runs page h1 tagline conditional** `runs/page.tsx:476-478` — wrap accent span: `{(!runs || runs.length === 0) && <span className="accent">…</span>}`. When data present, render `<span style={{color:'var(--ink-2)',fontWeight:400}}> {stats.total} run{stats.total!==1?'s':''}</span>`. **Effort: trivial.** Deps: P0-1-A (scoped orange rule).

- [ ] **P2-8-B Traces/Activity/Analytics h1 taglines** `traces/page.tsx:596-598`, `activity/page.tsx:424-426`, `analytics/page.tsx:181-183` — remove `.accent` / `<em className="accent">` spans entirely; let `.editorial-sub` carry factual context. Delete now-unused `.traces-heading-em` rule at `globals.css:6137`. **Effort: trivial per file.** Deps: P0-1-A.

- [ ] **P2-9 Sidebar section label typography** `globals.css:444-451`:
  ```css
  .app-nav-section-label {
    font-size: var(--fs-2xs);
    font-weight: 500;
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--ink-3);
    padding: 10px 8px 3px;
  }
  ```
  `--ink-3` contrast already corrected by P0-1-A (`#706550` = 4.65:1). **Effort: trivial.** Deps: P0-1-A.

- [ ] **P2-10 QuiltBg mosaic clip** `globals.css:2378-2388` — add CSS mask to `.quilt-bg`:
  ```css
  .quilt-bg {
    mask-image: linear-gradient(to right, transparent 38%, rgba(0,0,0,0.6) 58%, black 72%);
    -webkit-mask-image: linear-gradient(to right, transparent 38%, rgba(0,0,0,0.6) 58%, black 72%);
  }
  @media (max-width: 900px) {
    .quilt-bg {
      mask-image: linear-gradient(to bottom, transparent 42%, rgba(0,0,0,0.5) 62%, black 78%);
      -webkit-mask-image: linear-gradient(to bottom, transparent 42%, rgba(0,0,0,0.5) 62%, black 78%);
      opacity: 0.65;
    }
  }
  ```
  Simplify `.quilt-content::before` gradient to a light wash — no longer doing double-duty as text contrast guard. **Effort: small.** Deps: none. Independent of P0.

---

### P3 — Low-urgency, bundle with any open PR touching the component

- [ ] **P3-11 Remove duplicate offline state from NeedsAttentionBand** `page.tsx:341-353` — delete the `if (!bridgeOk)` branch returning the `attention-offline` div; remove `bridgeOk` from props interface. `BridgeOfflineBanner` in Shell handles it. **Effort: trivial.** Deps: none.

- [ ] **P3-12 Halts RelationStrip chip conditional tone** `runs/page.tsx:500-507` — change `tone: "warn"` to `tone: haltSummary?.total > 0 ? "err" : undefined`. When no halts, chip is ghost like siblings. **Effort: trivial.** Deps: none.

- [ ] **P3-13 Recipe avatar lightness cap** `page.tsx:403-407` — replace `ragColor`:
  ```ts
  function ragColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    const lightness = (hue >= 40 && hue <= 200) ? 28 : 34;
    return `hsl(${hue}, 55%, ${lightness}%)`;
  }
  ```
  Yields ≥5.2:1 with white across all hues. No CSS change. **Effort: trivial.** Deps: none.

- [ ] **P3-14 HintCard dismissal** — already persists to localStorage via `patchwork.hint.*.dismissed`. Verify `findHint('traces')` returns non-null in `src/lib/hints.ts`. **Effort: verify only, no code change.**

---

### Original-plan items folded in (still open, not covered by the 14 live issues)

- [ ] **Orig-6 Reduced-motion gate** `globals.css` — wrap `pill-pulse`, `runs-pulse`, QuiltBg entrance animations in `@media (prefers-reduced-motion: no-preference)`. **Effort: small. P2 tier.**

- [ ] **Orig-7 Focus-trap in modals/sheets** — audit `RecipeEditSheet`, `ApprovalModal`; ensure `focus-trap-react` or native `<dialog>` traps tab. **Effort: medium. P1 tier.**

- [ ] **Orig-8 Sidebar Activity section collapse** `Shell.tsx` + `navRoutes.ts` — collapse 6 Activity sub-items to 1 entry point. **Effort: medium. P2 tier.**

- [ ] **Orig-15 Dark-mode `--ok` on dark canvas** — `--ok` (#5b8a4f) at 4.87:1 on dark is borderline; add dark-mode override `--green: #6da060` (5.7:1) in `[data-theme="dark"]`. **Effort: trivial. Bundle with P0-1-A.**

- [ ] **Orig-19 `.label-eyebrow` utility class** — extract the section-label pattern into a reusable utility after P2-9 typography fix; replace one-off usages. **Effort: small. P3 tier.**

- [ ] **Orig-25 QuiltBg animation gate** `QuiltBg.tsx` — gate entrance animation to `sessionStorage.getItem('quilt-seen')` so it only plays once per session. **Effort: small. P3 tier. Independent of P2-10.**

- [ ] **Orig-card-class Card class cleanup** — `globals.css` has `.card`, `.glass-card`, `.stat-card`, `.runs-stat-card`, `.quilt-aside` all sharing structural but not semantic rules. Consolidate base structural rules into `.card` and use modifier classes. **Effort: medium. P3 tier.**

---

## Sequenced rollout

### PR 1 — Token grammar + global cascade (keystone)

Everything in P0-1-A through P0-1-J, P0-2, P0-3-A through P0-3-D, plus Orig-15 dark-mode `--ok` override.

Single PR because all changes are in `globals.css` plus mechanical 1-line re-points across ~15 files. No logic changes. Easy to review as a diff where every change is either a token value or a `var(--accent)` → `var(--something-else)` swap.

Also include P2-9 sidebar label typography (4-line CSS change, zero risk, zero deps) and P3-13 `ragColor` fix (self-contained function swap).

**Files touched:** `globals.css`, `Sparkline.tsx`, `HBarList.tsx`, `activity/page.tsx`, `traces/page.tsx`, `decisions/page.tsx`, `approvals/[callId]/page.tsx`, `runs/[seq]/page.tsx`, `sessions/page.tsx`, `tasks/page.tsx`, `transactions/page.tsx`, `recipes/_components/DoctorPanel.tsx`, `recipes/_edit/page.tsx`, `recipes/_plan/page.tsx`, `EntityTimeline.tsx`, `page.tsx` (ragColor only).

### PR 2 — Runs page render fixes + attention band

P0-2 (errored card bg), P0-3-B (running dot cleanup), P0-3-C (statusPill unification), P0-3-D (progress fill default), P1-6 (duration aria-label), P1-7 (attention band ordering + severity), P2-8-A (runs h1 conditional tagline), P3-12 (Halts chip conditional tone).

All changes are in `runs/page.tsx`, `globals.css` (additive rules only), and `StatusPill.tsx`. Grouped here because they all touch the Runs page and the attention band which is directly below.

### PR 3 — Overview page P1 fixes + sparkline labels

P1-4 (sparkline labels + hours24Labels construction), P1-5-A/B/C (FeaturedRecipeAside display name, SuccessRing %, empty state), P2-10 (QuiltBg mask), Orig-25 (QuiltBg animation gate).

All changes are in `page.tsx`, `FeaturedRecipeAside.tsx`, `SuccessRing.tsx`, `globals.css` (mask rule), `QuiltBg.tsx`.

### PR 4 — Operational pages P2-8 + P3 cleanup

P2-8-B (traces/activity/analytics tagline removal), P3-11 (remove duplicate offline state), P3-14 (verify HintCard, no code change), Orig-6 (reduced-motion), Orig-19 (`.label-eyebrow` extraction), card-class consolidation pass.

### PR 5 — Structure and a11y

Orig-7 (focus-trap audit), Orig-8 (sidebar Activity collapse). These require the most product judgment and carry the most regression risk — sequence last so earlier PRs don't block on them.

---

## Reconciliation note

| Issue | Status | Original plan item |
|---|---|---|
| P0-1 Orange overload | **New** — no original item covered the breadth of re-pointing; Orig-21 named the grammar but not the sites | Supersedes Orig-21 |
| P0-2 Errored card contrast | **New** | — |
| P0-3 Status pill inconsistency | **New** | — |
| P1-4 Sparkline no labels | **New** (Orig-21 touched sparkline color only) | Extends Orig-21 |
| P1-5 Featured recipe hero fallbacks | **New** | — |
| P1-6 Duration bar unlabeled | **New** | — |
| P1-7 Attention band urgency hierarchy | **New** | — |
| P2-8 Tagline on operational pages | **Conflicts with Orig-20** (which wanted more serif spans) | Supersedes Orig-20; P0-1 orange reservation makes P2-8 the correct resolution |
| P2-9 Sidebar section labels | **New** | Partially overlaps Orig-8 (adjacent files); independent fix |
| P2-10 QuiltBg mosaic bleed | **New** | Partially overlaps Orig-25 (same component, different concern) |
| P3-11 Dual offline alerts | **New** | — |
| P3-12 Halts chip filled state | **New** | — |
| P3-13 Avatar contrast | **New** | — |
| P3-14 HintCard dismissal | **Already implemented** — no code change needed | — |
| Orig-6 Reduced-motion | **Still open** | Fold into PR 4 |
| Orig-7 Focus-trap | **Still open** | PR 5 |
| Orig-8 Sidebar collapse | **Still open** | PR 5 |
| Orig-15 Dark --ok | **Still open** | Bundle into PR 1 |
| Orig-19 label-eyebrow | **Still open** | PR 4 |
| Orig-20 Extend serif spans | **Superseded by P2-8** | Drop |
| Orig-21 Orange grammar | **Superseded by P0-1** (P0-1 is fully grounded; Orig-21 was directional) | Drop |
| Orig-25 QuiltBg animation gate | **Still open** | Bundle into PR 3 |
| Orig card-class cleanup | **Still open** | PR 4 |


---

## Addendum — refinements (2026-06-04)

---

### 1. Design guardrails (prevent recurrence)

The three anti-patterns below each have a direct plan anchor. Apply this checklist to every new component before merging.

#### Checklist

**[G-1] Bounding box discipline** *(reinforces P2-10 — layout density)*
- Every panel/card gets a fixed or max-width bounding box with `overflow: hidden` on the container.
- Decorative or background text lives on a dedicated `z-index` layer (e.g. `z-0`) separated from live content (`z-10`+). Never place two content regions in the same visual column without an explicit divider (`border`, `gap`, or `padding`).
- `position: absolute` children require a `position: relative` parent with explicit `width`/`height` — no implicit overflow bleed.

**[G-2] Typography & contrast** *(reinforces P2-9 — typography scale + token grammar)*
- `letter-spacing` on UI labels: `≤ 0.02em`. The current design token for mono labels is `0.04em` (`--tracking-wide`) — reserve that value for code/mono contexts only; prose labels use `normal` or `0.01em`.
- Case: sentence case on all labels. `text-transform: uppercase` requires explicit sign-off and a contrast check.
- Minimum contrast: `4.5:1` for normal text (< 18 px / 14 px bold); `3:1` for large text. Run `globals.css` `color-mix()` combos through a contrast checker before shipping.

**[G-3] Status-pill color construction** *(reinforces P0-3 — chip/pill component)*
- Pills must use: soft background + dark text from the **same color ramp**. Pattern: `background: var(--green-soft); color: var(--green-900)` (or `color-mix(in srgb, var(--green) 18%, var(--card-bg))` with `color: var(--green)` at ≥ 4.5:1 ratio on that bg).
- No saturated foreground color on a dark/neutral background. The `--amber`, `--err`, `--ok` tokens are for borders and icon strokes, not pill background fills on dark surfaces.
- Status dot (`·` or `<span>`) uses the **same token** as the label text — never a separate decorative color.

---

### 2. Traces unlabelled bars — new P1 item

**Finding (grounded):** `dashboard/src/app/traces/page.tsx`

Four compounding issues make waterfall bars unreadable:

1. **`SpanBar` silently discards `label`** — the prop is declared in the type at line 312 (`label?: string`) but never destructured; no `title`, `aria-label`, or tooltip is emitted. Compare `RunSparkBars.tsx` line 120: `<title>{barTooltip(run, i, slotCount)}</title>` inside each `<rect>` — the established native-tooltip pattern.

2. **Child call sites pass no `label`** — lines 901–907 omit the prop entirely, so children remain unlabelled even after the destructuring fix.

3. **No axis ticks** — `.traces-waterfall` CSS (line 6244) has no `0 … Nms` axis strip. `EventsHistogram.tsx` lines 110–133 shows the established pattern (flex row of monospace time labels beneath the chart).

4. **No color legend** — `TYPE_THEME` at line 57 maps all four `TraceType` values to colors (`--blue`, `--purple`, `--amber`, `--green`) but no legend key is rendered; a reader cannot distinguish `recipe_run` from `decision` bars.

**Proposed fix (additive, no layout library):**

- Destructure `label` in `SpanBar`; emit `aria-label={label ?? \`${durationMs}ms\`}` and `title={...}` on the outer `div.traces-span-track` in all three render branches (full-bar ~line 340, zero-duration tick ~line 327, zero-range fill ~line 316).
- Pass a composed label from child call sites (lines 901–907): `label={[child.key, childDuration > 0 ? \`${childDuration}ms\` : 'instant', \`+${child.ts - groupStartMs}ms from start\`].join(' · ')}`.
- Add a two-tick axis div after `.traces-span-bar-wrap` close tag: `<div className="traces-waterfall-axis" aria-hidden="true"><span>0</span><span>{groupEndMs - groupStartMs}ms</span></div>` with CSS `display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: var(--fs-3xs); color: var(--ink-3)`.
- Add a four-swatch legend strip above the tree-view card using `Object.entries(TYPE_THEME)`: `8px × 8px` colored `border-radius: 2px` swatches with `font-size: var(--fs-2xs); color: var(--ink-2)`.

**Plan slot:** Insert as **P1-5a** between P1-4 (data context) and P1-6 (decision-detail drawer). Effort: small (items 1/2/4) + medium (item 3, axis layout restructure).

---

### 3. "Needs attention" band redesign — refines P1-7

**Grounded state** (`dashboard/src/app/page.tsx` lines 318–394, `globals.css` lines 5418–5470):

The band renders three fixed item types — `pendingCount` (approvals), `haltCount24h` (halts), `failingCount24h` (failed runs) — with a critical urgency inversion: `urgent: true` maps to `.attention-chip--urgent` → amber (`--warn`), while `urgent: false` maps to `.attention-chip--warn` → red (`--err`). Failed runs and halts are more severe than pending approvals yet render in the higher-alarm color. The band border (`border-left: 3px solid var(--warn)`, line 5421) is always amber regardless of severity mix.

**Recommended direction: B + E hybrid**

Directions A (cleaned-up current) does not resolve the inversion. C (usage bar) is inapplicable — the data is a count, not a quota. D (one-line collapse) loses the per-type deep-links users need. E alone would over-expand the chip. B (icon-led, per-type severity) + E (inline CTA on the approval chip only) fits the real data.

**Concrete markup and token fix:**

Replace the `urgent: boolean` discriminant with `severity: 'err' | 'warn'`:
- `pendingCount` → `severity: 'warn'` (amber, `.attention-chip--warn`)
- `haltCount24h` → `severity: 'err'` (red, `.attention-chip--err`)
- `failingCount24h` → `severity: 'err'` (red, `.attention-chip--err`)

Chip class: `attention-chip attention-chip--${item.severity}`.

Rename CSS classes in `globals.css` lines 5461–5470:
```css
.attention-chip--warn {
  background: color-mix(in srgb, var(--warn) 10%, var(--card-bg));
  border-color: color-mix(in srgb, var(--warn) 40%, var(--line-1));
  color: var(--warn);
}
.attention-chip--err {
  background: color-mix(in srgb, var(--err) 8%, var(--card-bg));
  border-color: color-mix(in srgb, var(--err) 32%, var(--line-1));
  color: var(--err);
}
```

Drive band border from highest-severity item present via `data-severity` on the band `div` (computed as `items.some(i => i.severity === 'err') ? 'err' : 'warn'`):
```css
/* globals.css — after line 5429 */
.attention-band[data-severity="err"] {
  border-left-color: var(--err);
  background: color-mix(in srgb, var(--err) 4%, var(--card-bg));
  border-color: color-mix(in srgb, var(--err) 18%, var(--line-1));
}
```

Add a contextual SVG icon per `href` key (clock for `/approvals`, octagon for `/runs?halt=1`, circle-exclamation for `/runs?window=24h`) inside `.attention-chip-icon { display: inline-flex; width: 18px; height: 18px; border-radius: 4px; background: color-mix(in srgb, currentColor 16%, transparent); }`.

For the approval chip only (`item.href === '/approvals'`), render a non-link wrapper div with an inner `<Link className="attention-chip-cta">Review →</Link>` to the right of the label. All other chips keep the existing full-chip `<Link>` with `→` arrow.

The `.attention-offline` state (`page.tsx` lines 341–354) is correct in behavior but should use `--warn` (not `--err`) for its band border and background, since `BridgeOfflineBanner.tsx` already claims the `--err`/red register at page-top. Change `globals.css` lines 5408–5410 to `border-left: 3px solid var(--warn)` while keeping `.attention-offline-label` in `--err` so the word "Bridge offline" remains red.

---

### 4. Validation note

The live re-critique's three cross-cutting themes map cleanly onto existing plan items without requiring structural changes. Orange/amber overload (chips, band, halt panel, toasts all pulling `--warn`/`--amber` when severity warrants `--err`) directly corroborates **P0-1** (token grammar discipline — the root cause is tokens used by feel rather than semantic role). The editorial-voice-vs-operational tension — "Needs attention" as a heading on a band that contains machine-precise counts and deep-links — corroborates **P2-8** (copy and microcopy pass, distinguishing ambient status from actionable alerts). The data-without-context critique (unlabelled bars, count chips with no rate/trend, halt counts with no drill-down preview) corroborates **P1-4** and **P1-6** (data context layer and decision-detail drawer). No plan items need to move; these are independent confirmations that the prioritization is correct.
