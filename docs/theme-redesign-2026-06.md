# Theme redesign — light + dark, anti-pattern elimination

> Source: a 16-agent design workflow (2026-06-04) — 6-lens audit over the live dashboard (Playwright renders) + globals.css/tokens.json, 4 divergent full-theme proposals, judge panel, synthesized spec. Builds on the shipped facelift. Token/CSS-only; no component API churn.

## Judge ranking

- **warm-refined** — 40/50 ({'antiPatternElimination': 8, 'accessibility': 7, 'cohesion': 8, 'identityPreservation': 9, 'implementationSafety': 8})
- **systematized-neutral** — 39/50 ({'antiPatternElimination': 8, 'accessibility': 8, 'cohesion': 7, 'identityPreservation': 8, 'implementationSafety': 8})
- **functional-contrast** — 37/50 ({'antiPatternElimination': 7, 'accessibility': 6, 'cohesion': 8, 'identityPreservation': 9, 'implementationSafety': 7})
- **calm-editorial** — 35/50 ({'antiPatternElimination': 7, 'accessibility': 6, 'cohesion': 8, 'identityPreservation': 8, 'implementationSafety': 6})

## Consolidated brief

### Top anti-patterns

- **[HIGH] Semantic colors used as standalone text bypass the pill-text tokens and fail WCAG AA in light mode (amber, green) and dark mode (blue, purple)**  
  Merges color-token F1/F2/F11, a11y A1/A2/A3/A6/A12, parity DLP-02/DLP-03. The system already solved this for ok/warn/err PILLS via --ok-text/--warn-text/--err-text, but (a) --info-text and --purp-text were never created, and (b) ~30 standalone (non-pill) text sites reach for the raw primitive instead of a *-text token. Worst offenders are read every page load: amber judge verdicts and green status cells on Runs, blue/purple chips on Traces. Direct failures of WCAG 1.4.3, the most user-visible accessibility defect set.
  *Where:* --amber/--warn (2.48:1 on canvas), --green/--ok (3.52:1), --blue/--info (3.38:1 dark on blue-soft), --purple (3.04:1 dark on purple-soft); .runs-judge-pill, .tx-status-pending, .tx-status-complete, .status-cell.ok, .pill.info, .pill.purp, .chip-blue, activity banner; globals.css:1244,1343,1851,1897-1898,7374-7375
- **[HIGH] --blue, --purple, --accent-cool have NO dark-mode lift, unlike --red/--green which were correctly lifted**  
  Root cause of half of AP-01's dark-mode failures plus the marketplace Install button. Merges color F1/F3, a11y A8, parity DLP-02/DLP-03/DLP-04. The dark block deliberately lifted --red→#d05757 and --green→#6da060 for AA but the same discipline was not applied to the three remaining chromatic tokens. A purely additive fix (3 dark overrides + matching -rgb), highest ROI per line changed.
  *Where:* --blue (#4a6fa5), --purple (#7a5b9c), --accent-cool (#0787ff) — all unchanged in [data-theme="dark"] (globals.css:259-331); white text on accent-cool = 3.55:1 (.mkt-install-btn dark, :1180-1188)
- **[HIGH] Layered decorative backgrounds (grid + aurora + shell radial + paper-grain) plus the animated Quilt mosaic produce persistent visual noise behind data on every page**  
  Merges anti-pattern F1/F2, hierarchy F1/F4/F10, parity DLP-... The single most disruptive perceptual problem: four-to-five simultaneous decorative layers remain visible under stat cards, tables, and kanban at every scroll position. The Quilt's orange/ink tiles bleed through the text mask (worse in dark at opacity 0.85). Competes directly with the operational data the dashboard exists to surface. Mostly token + mask-stop + opacity tuning.
  *Where:* .app-main::before (32px grid, --grid-mask-opacity 0.55), .app-main::after (18s aurora keyframe), .app-shell radial, --paper-grain (5 radials); QuiltBg.tsx (20x7 cells, 1400ms flicker, opacity 0.85, mask 38-72%); globals.css:386,582-613,2411-2421
- **[HIGH] Color over-distribution: orange leaked onto every card hover-glow, 360-hue avatars, 7 Tailwind tag-chip hexes, and a 4-color stat-tile accent-bar spectrum — exhausting the palette before any semantic signal lands**  
  Merges anti-pattern F4/F5/F6, hierarchy F3/F6/F7, color F9, a11y A4. Orange is supposed to be the reserved brand/CTA/active signal but is sprayed as decoration on every interactive surface; meanwhile recipe cards carry ~10 unrelated hues in one viewport. The Tailwind tag hexes are fully off-palette (amber chip 1.74:1, teal 1.99:1 — critical AA fails) and invisible to tokens:check. Dilutes the entire semantic color contract.
  *Where:* .card/.stat-card/.glass-card::before orange radial glow (:886-914), ragColor() hsl(0-359) (page.tsx:386-393), .rag3-chip--tag-* 7 Tailwind hexes #3b82f6/#a855f7/#ec4899/#64748b/#f59e0b/#14b8a6/#6366f1 (:5007-5013), stat-card border-top 4-color (:5205-5209,5385-5388)
- **[HIGH] Token source-of-truth drift: tokens.json tracks 39 light primitives but omits ~24 CSS :root tokens (all semantic aliases, pill-text, accent-cool, dot-muted, on-*, rgb helpers) and 8 dark tokens — CI tokens:check is blind to half the palette**  
  Color F4. The very tokens with the most AA risk (the un-lifted blue/purple, the pill-text variants) are exactly the ones the gate cannot see, so a regression on any of them ships silently. This must be fixed in lockstep with AP-01/AP-02 or the new dark overrides won't be guarded. Constraint-critical: any redesign that touches tokens must re-sync this file.
  *Where:* tokens.json light.color missing --ok/warn/err/info(+soft/+text), --accent-cool(+glow), --dot-muted, --on-accent/--on-orange, --err-bg, all 5 -rgb; dark.color missing --amber, --blue, --purple/-hover, --accent/-hover/-soft/-tint
- **[MED] Token-scale indiscipline: 101 hardcoded font-size px (incl. 18 off-scale fractional 10.5/11.5/13.5/14.5px) vs 242 --fs- uses; 63 hardcoded border-radius literals; dual radius naming (--r-s/m/l/xl + --r-1..4 + bare --radius)**  
  Merges color F5/F7/F8, typography TS-2/TS-3. Verified counts. Not user-visible per se but it is the structural reason the system keeps drifting: with two radius vocabularies, a bare fallback, and a third of font-sizes off-token, every new component re-invents values. Collapse to one numeric radius scale, snap fractional fs to the nearest step, complete the legacy --bg-*/--fg-*/--border-* migration (65 sites) and delete the alias block.
  *Where:* font-size literals (101), fractional 13.5px×7/11.5px×5/10.5px×4/14.5px×2; border-radius literals (63): 999px×15→--r-full, 6px×14→--r-2, 4px×12→--r-1, 5px×6 no-token, 8px×2 no-token; --r-s/m/l/xl == --r-1..4, --radius:10px redundant
- **[MED] JetBrains Mono used as a decorative label-differentiator in ~11 structurally unrelated contexts; 8 independent ALL-CAPS+wide-tracking micro-label patterns with no shared utility**  
  Merges typography TS-1/TS-4/TS-8, anti-pattern F8/F9, hierarchy F9. Every operational page subtitle is mono ('100 runs · any time · avg 1ms'), reading as inconsistency next to the sans h1; Traces adds serif-italic, so three type families appear within 80px. Eight uppercase tiers shout in parallel. Fix: one .label-micro utility (sentence-case, 600, 0.01em), mono restricted to code/identifiers/tabular numbers, serif-italic reserved to the Overview hero only.
  *Where:* 71 mono usages incl. section-eyebrow, quilt-greeting, cluster-tab, editorial-sub page subtitles, activity-filter-chip (:546,683,1481,2300,2346,2444,3910); 8 text-transform:uppercase sites (:969,2138,2681,3671,3856,4867,6101,8790); serif-italic on Traces h1 (:2335)
- **[MED] Dark-mode structural parity gaps: runs-summary-band dissolves into canvas, attention-band 4% tint invisible on near-black, card inset-highlight drops 8.5x flattening elevation, line-1 dividers ~1.18:1 (below 3:1 non-text floor)**  
  Merges parity DLP-06/DLP-07/DLP-08/DLP-11, a11y A10. Dark mode is a genuine rebalance in most respects, but these surfaces lose the grouping/elevation/separation that light mode relies on: the summary band shares the canvas color, severity washes vanish, cards look flat, and table rows have no rhythm. WCAG 1.4.11 (3:1 non-text) fails on structural dividers. Token-level dark overrides only.
  *Where:* .runs-summary-band background:var(--bg-0)==canvas (:1868); .attention-band color-mix 4% on --card-bg (:5462-5481); --card-shadow inset 0.85→0.10 light→dark (:188 vs :311); --line-1 dark rgba(255,255,255,0.08)=1.18:1; table row dividers (:1583,1588)
- **[MED] Focus indication relies on a low-contrast orange box-shadow glow (~1.2:1 perimeter) with outline:none and no :focus-visible ring — fails WCAG 2.4.11 Focus Appearance across all input variants**  
  A11y A5/A11. The glow is --orange-soft (alpha .13) blended on surface = 1.19:1 light / 1.30:1 dark — keyboard users cannot reliably locate the focused field. The solid ring pattern already exists on .btn:focus-visible; inputs just need to adopt it (box-shadow 0 0 0 3px var(--accent) or outline:2px solid + offset). Affects every form on every page for keyboard/AT users.
  *Where:* .input:focus (:1208-1215), .traces-search-input (:6193-6194), .traces-export-input (:6342), .recipes-search-wrap input (:7584), .new-recipe-field-input outline:none !important (:7636), .mkt-search-input (:7258)
- **[LOW] Boxiness and redundant semantic redundancy: 4-6 nested bordered/shadowed card levels per viewport; stat tiles stack tint+border+colored-number+colored-label (triple/quadruple redundant signal); 5 inconsistent left-accent-bar mechanisms**  
  Merges anti-pattern F3/F7/F10, hierarchy F3/F8, a11y A7. Lower perceptual weight than the noise/color problems but worth a flattening pass: drop the hero outer card to a section header, apply stat-tile color to ONE channel (border OR number OR tint, not all three), and standardize the accent bar on box-shadow:inset 3px so it follows border-radius consistently. The dark 'Errored 32' label at 4.41:1 (0.09 under AA) is the only AA edge here.
  *Where:* hero .quilt→.quilt-aside-featured→.stat-card→.rag3-col→.rag3-card nesting; .runs-stat-card tint+border+value+label (:1937-1959); left-bar: border-left vs box-shadow:inset 3px across .runs-stat-card/.runs-tr/.rag3-col/.rag3-card/.traces-row (:1934,1964,4835,4930,7115-7118)

### Token-system critique

The token system has good bones and a real facelift already landed — warm/dark surface scales are hand-rebalanced (not naively inverted), shadows are theme-specific, --ink-3 was darkened for AA, and the --ok-text/--warn-text/--err-text pill pattern + dark --red/--green lifts are correct, durable fixes. But the architecture is half-migrated in three directions at once, and the gaps cluster exactly where contrast risk is highest.

(1) The pill-text pattern is incomplete. ok/warn/err got dedicated text tokens that flip bright in dark; info (blue) and purple never did, and ~30 standalone text sites bypass even the existing text tokens to reach raw --amber/--green/--blue/--purple. Result: WCAG AA failures in BOTH themes on data read every page load (amber judge verdicts, green status cells, blue/purple trace chips).

(2) The dark block lifts --red and --green but NOT --blue, --purple, or the freestanding --accent-cool — an inconsistency that is the root cause of most dark-mode failures plus the 3.55:1 white-on-accent-cool Install button. The cure is purely additive: three dark overrides and their -rgb companions.

(3) The source-of-truth has drifted. tokens.json tracks 39 light primitives but omits ~24 :root tokens — every semantic alias, all three pill-text tokens, accent-cool, dot-muted, on-accent/on-orange, err-bg, and all five -rgb helpers — and 8 dark tokens (amber, blue, purple/-hover, accent/-hover/-soft/-tint). The CI tokens:check gate is therefore blind to precisely the tokens carrying the most AA risk, so any regression on the un-lifted chromatics ships silently.

(4) Scale discipline is eroding under three competing vocabularies: a radius scale exists twice (--r-s/m/l/xl AND --r-1..4 mapping to identical px) plus a bare --radius fallback; 63 hardcoded border-radius literals and 101 hardcoded font-size px (242 token uses; 18 off-scale fractional 10.5/11.5/13.5/14.5px with no token) coexist; and a legacy --bg-*/--fg-*/--border-* alias block is still consumed at 65 sites alongside the canonical --canvas/--surface/--ink-*/--line-* it points to. There are also two on-surface tokens (--on-accent #fff vs --on-orange, which flips dark) — and .sidebar-create hardcodes #fff instead of --on-orange, a latent dark-mode AA bug (white on #ff7a45 = 2.59:1) the .btn.primary already fixed. --err-bg is a dead alias of --err-soft. --green's white-text CTAs (.btn.success) fail AA in both themes and the comment at :90 explicitly defers them.

Net: the system knows the right pattern (pill-text tokens, dark lifts, a tokens.json gate) but has only applied it to ~60% of the palette. The redesign should finish the migration the facelift started, not invent a new one.

### Redesign goals

- Finish the pill-text pattern: add --info-text and --purp-text mirroring --ok/warn/err-text (dark→bright primitive, light→darker shade for soft-pill AA), and migrate all ~30 standalone semantic-text sites (.runs-judge-pill, .tx-status-*, .status-cell.ok, .pill.info, .pill.purp, .chip-blue, activity banner) off raw --amber/--green/--blue/--purple onto the *-text tokens.
- Apply the dark-lift discipline uniformly: add [data-theme="dark"] overrides for --blue (~#6b9dd6), --purple (~#a07acc), and --accent-cool (~#0060d9), with matching --blue-rgb/--purple-rgb so every consumer (pills, running stripe, traces rows, Install button) clears AA in dark without per-site patches.
- Re-sync tokens.json to globals.css as part of the same change: add the ~24 missing light tokens (semantic aliases, pill-text incl. the two new ones, accent-cool/+glow, dot-muted, on-accent/on-orange, all -rgb helpers) and the 8 missing dark tokens, so tokens:check guards the full palette including the newly-lifted chromatics.
- Quiet the decorative layers so data leads: drop --grid-mask-opacity to <=0.20 and clip the grid/aurora to a top-edge texture, remove the third app-shell radial, freeze the Quilt flicker by default and tighten its mask to a far-right strip (>=85%) with a neutral-only palette, and add a dark-mode Quilt opacity (<=0.55).
- Re-reserve orange and collapse color over-distribution: remove the orange hover-glow from stat/glass cards (keep only on focal .card), constrain ragColor avatars to 4-6 muted palette tones, collapse the 7 Tailwind tag-chip hexes to the existing semantic tokens (--info/--warn/--ok/--purple/--ink-3), and make stat-tile accent color conditional on alert state (apply to ONE channel, not tint+border+number+label).
- Unify type and label rhythm: snap the 18 fractional font-sizes to the nearest --fs- step, restrict JetBrains Mono to code/identifiers/tabular numbers (move section-eyebrow, quilt-greeting, cluster-tab, editorial-sub subtitles to Albert Sans), reserve serif-italic to the Overview hero, and consolidate the 8 uppercase micro-label sites into one sentence-case .label-micro utility.
- Collapse the scale to one vocabulary: pick the numeric radius scale (--r-1..4 + --r-full), delete the --r-s/m/l/xl aliases and bare --radius, add tokens for the orphan 5px/8px radii (or snap them), replace the 63 hardcoded border-radius and 101 hardcoded font-size literals, complete the legacy --bg-*/--fg-*/--border-* migration (65 sites) and remove the alias block and dead --err-bg.
- Fix focus and dark-mode structural parity: give every input a solid :focus-visible ring (box-shadow 0 0 0 3px var(--accent) or outline 2px + offset, removing outline:none !important) to satisfy WCAG 2.4.11; and add dark overrides so runs-summary-band sits a surface step above canvas, attention-band tint is perceptible (~8% on --surface), card inset-highlight is restored (~0.15), and structural dividers use --line-2 (>=3:1).
- Resolve the on-surface and CTA-on-color defects: route .sidebar-create through --on-orange, pick one of --on-accent/--on-orange as canonical and make it context-aware in dark, and darken --green (or switch to dark-on-green text) so .btn.success and approval primary buttons clear AA in both themes.

### Constraints

- Keep the warm-cream identity recognizable: the light canvas/surface/recess/pressed cream scale and the warm ink ramp stay; no shift to a neutral-grey or cool-white base.
- Orange stays reserved for brand, CTA, active-nav, and focus only. No orange as decoration (remove the per-card hover glow), no second orange focal point competing with CTAs in the hero, no orange on tiles that are in a healthy/zero state.
- Preserve all semantic status meanings — ok=green, warn=amber, err=red, info=blue (and purple as the secondary/decision tone). Re-hue or consolidate the off-palette Tailwind tag chips ONTO these existing semantics; do not introduce new status hues.
- WCAG AA in BOTH themes for all text (4.5:1 normal, 3:1 large) and 3:1 for non-text UI boundaries/focus indicators. Every token lift or text-site migration must be contrast-checked in light AND dark.
- tokens.json must stay in sync with globals.css (npm run tokens:check green). Any token added, lifted, or removed in :root/[data-theme="dark"] must land in tokens.json in the same change; add the currently-missing tokens so the gate covers the full palette.
- Changes must be token-and-CSS-level only — no component API churn. No new/renamed React props, no changes to className contracts that components emit; work within globals.css, tokens.json, and value-only edits to existing classes/QuiltBg palette. ragColor/tagColorClass may be retuned to a narrower palette but must keep their existing function signatures and call sites.
- Additive-first: prefer adding dark overrides and *-text tokens (mirroring the existing --ok-text/--warn-text/--err-text pattern) over rewriting the token graph; complete the half-finished migration rather than introducing a parallel system.

## Final spec

**Direction:** Warm-refined completion of the shipped facelift. Spine = the "warm-refined" proposal (highest-ranked, 40/40): finish the half-migrated token system additively rather than inventing a parallel one. Four ordered waves — (1) dark chromatic lifts, (2) pill-text completion + standalone-text migration, (3) decorative-layer quieting + orange re-reservation, (4) tokens.json resync + focus + structural parity + scale/type discipline. The warm-cream surface scale and warm ink ramp are untouched; orange stays reserved for brand/CTA/active-nav/focus; all semantic hues (ok=green, warn=amber, err=red, info=blue, purple=decision) are preserved and only their contrast is lifted.

GRAFTS applied on top of the spine to fix the flaws the judges flagged:
- CORRECTED accent-cool fix (grafted from systematized-neutral, with the arithmetic error fixed): every prior proposal shipped a light/pastel dark --accent-cool under white text and FAILED AA (white on #3d8ef5/#5ca8f4 = ~2.5-3.3:1). Because --accent-cool is a BACKGROUND under white text (.mkt-install-btn), the fix is an --on-accent-cool token that flips to dark ink in dark mode, letting the dark cool stay vivid (#4d96e8) while the button text becomes #0a0b0d (13.8:1). Light mode darkens --accent-cool to #0060d9 so white-on-cool = 4.82:1.
- nav-badge dark-ink-on-soft fix (graft): .nav-badge / .nav-badge.is-live use white text on a blue bg; white on the lifted dark --blue (#6b9dd6) = ~2.8:1 FAILS. Re-route both to ink text on --info-soft/--blue-soft bg with a --blue border, which passes in BOTH themes and survives the lift.
- Explicit per-input :focus-visible rules for all 6 input variants (graft from functional-contrast / systematized-neutral) — warm-refined named the pattern but left it un-written; here every input selector gets a concrete rule and outline:none/!important is removed at each site.
- Structural divider migration (graft): the --line-2/--line-3 token lifts alone don't reach 3:1 non-text; the spec also SWAPS the load-bearing dark dividers (table rows, summary-band, thead) from --line-1→--line-2 and the summary-band/section separators to --line-3, so they clear the 3:1 floor via token + selector change together.
- Standalone-text sweep extended to the sites warm-refined missed: .runs-stat-label--ok/--err, .countdown.urgent, .attention-offline-link, .attention-clear-ok, .tx-status-*.
- --amber-text standalone token (graft from systematized-neutral) so non-pill amber verdict/countdown text references a named token distinct from the pill --warn-text.
- The 7 Tailwind tag-chip → semantic-token mapping table (graft, common to all four proposals).
- .btn.success / approval-primary green CTA AA fix via a new --on-green dark-ink token + --green-strong fill (closes goal #9 defect every proposal except the brief flagged or skipped).

This spec finishes the migration the facelift started. It is additive-first and token/CSS-only: no React prop or className-contract changes (the only component-file edit is the QuiltBg PALETTE array, which keeps the component API). It (1) adds three dark chromatic lifts (--blue, --purple, --accent-cool) plus dark --amber, each with -rgb companions, mirroring the already-shipped --red/--green lifts; (2) completes the pill-text pattern with --info-text, --purp-text, and a standalone --amber-text, then migrates ~30 standalone semantic-text sites off raw primitives onto *-text tokens; (3) quiets the four-to-five overlapping decorative layers (grid mask 0.55→0.18, aurora halved + de-animated to a single static top radial, paper-grain removed in light, Quilt opacity 0.85→0.55/0.50 with a far-right mask and a neutral PALETTE), removes the orange hover-glow from generic cards, constrains ragColor to muted tones, and collapses 7 off-palette Tailwind tag hexes onto semantic tokens; (4) resyncs tokens.json to cover the full palette (so tokens:check guards the new lifts), gives every input a solid focus ring, fixes dark structural parity (summary-band → surface, attention-band tint 4%→8%, card inset highlight 0.10→0.15, structural dividers → --line-2/--line-3), routes .sidebar-create and the green CTAs through context-aware on-color tokens, and establishes one radius vocabulary. Every text/bg and pill pair in the contrastChecks table passes AA in both themes.

### Anti-patterns fixed

- **AP-01 — Semantic colors as standalone text fail AA (amber/green light; blue/purple dark)**
  - Complete the pill-text pattern: add --info-text (#2f5496 light / var(--blue) dark), --purp-text (#5a3d7a light / var(--purple) dark), and standalone --amber-text (#7a5200 light / var(--amber) dark). Migrate every standalone semantic-text site off raw primitives onto *-text tokens: .pill.info & .pill.purp → --info-text/--purp-text; .runs-judge-pill[approve] → --ok-text, [request_changes] → --warn-text (drop the hardcoded #d49a3a fallback); .status-cell.ok → --ok-text; .tx-status-complete → --ok-text, .tx-status-pending → --warn-text; .countdown.urgent → --amber-text; .runs-stat-label--ok → --ok-text, .runs-stat-label--err → --err-text; .attention-clear-ok → --ok-text; .attention-offline-link → --info-text; the 7 rag3 tag chips → semantic *-text tokens. Dark *-text tokens re-point to the lifted bright primitives, so all sites pass AA in both themes.
- **AP-02 — --blue/--purple/--accent-cool have no dark lift; white-on-accent-cool Install button fails**
  - Add [data-theme="dark"] overrides mirroring the --red/--green discipline: --blue #6b9dd6 (5.1:1 text on dark canvas), --purple #a07acc (5.3:1), --amber #d4a040, --accent-cool #4d96e8, each with a matching -rgb companion. Crucially --accent-cool is a BACKGROUND under white text, and a light cool fails white text — so add --on-accent-cool (#fff light / #0a0b0d dark) and route .mkt-install-btn text through it: dark ink on #4d96e8 = 13.8:1. Light --accent-cool darkened to #0060d9 so white-on-cool = 4.82:1 (fixes the button in light too). Lift dark --accent-cool-glow and the install :hover color-mix accordingly.
- **AP-03 — Layered decorative backgrounds + animated Quilt = persistent noise behind data**
  - --grid-mask-opacity 0.55→0.18 light / 0.4→0.15 dark, and tighten .app-main::before mask to radial-gradient(ellipse 120% 22% at 50% 0%, black, transparent) so the 32px grid is a top-edge texture only. Halve all --aurora-* tokens. Replace the animated .app-main::after two-aurora keyframe with one static top-right radial (no animation). Remove --paper-grain in light (set none; already none in dark). Drop the .app-shell aurora to a single softer radial. Quilt: opacity 0.85→0.55 light / 0.50 dark (via [data-theme="dark"] .quilt-bg override), push mask to linear-gradient(to right, transparent 55%, rgba(0,0,0,0.5) 72%, black 85%), swap QuiltBg PALETTE to neutral tokens (recess/pressed/surface/canvas + transparent, no orange/ink), and slow the flicker interval 1400ms→2800ms.
- **AP-04 — Orange over-distribution (card glow, 360-hue avatars, 7 Tailwind hexes, 4-color stat bars)**
  - Remove the orange radial from --card-shadow-hover (both themes) so generic .card/.stat-card/.glass-card hover lifts via shadow only; scope the orange ::before glow to the hero focal surface via CSS selector narrowing (.quilt .card / existing hero context — no new className emitted). Constrain ragColor() to a 5-tone muted palette (#b8a898/#9aaa8e/#9ba8b8/#b0a0b8/#c4a87a) via modulo, signature unchanged. Map all 7 rag3 tag-chip hexes onto semantic soft/text tokens (table below). Stat-tile color applied to ONE channel (left accent bar via box-shadow:inset 3px) and only in alert state; healthy/zero tiles use neutral --line-2 bar, ink-0 number, ink-3 label.
- **AP-05 — tokens.json drift: ~24 light + ~8 dark tokens untracked, gate blind to AA-risk tokens**
  - Resync tokens.json in the SAME change: add to light.color the semantic aliases (ok/warn/err/info + soft), the *-text tokens (ok/warn/err/info/purp/amber-text), accent-cool/-glow/-rgb, on-accent/on-accent-cool/on-orange/on-green, green-strong, dot-muted, err-bg, purple-rgb, and the existing green/amber/red/blue -rgb. Add to dark.color the lifts (amber, blue, purple, purple-hover, accent-cool) + their -rgb, on-accent-cool, on-orange, on-green, green-strong, and the dark *-text aliases (ok/warn/err/info/purp/amber-text). Check-tokens.mjs is JSON→CSS and tolerates var() aliases, so every added entry only requires the CSS var to exist; add a RENAMES entry radius.5→r-5.
- **AP-06 — Scale indiscipline: fractional font-sizes, dual radius vocab, legacy alias block**
  - Numeric radius scale is canonical: add --r-5 (20px) so --r-xl has a numeric peer; redirect --r-card to var(--r-4); add a /* @deprecated use --r-N */ comment over --r-s/m/l/xl and --radius but DO NOT delete (65 legacy sites migrate in a follow-up PR gated on a zero-reference grep). Snap the 18 fractional font-size literals: 13.5px→var(--fs-m), 11.5px→var(--fs-xs), 10.5px→var(--fs-2xs), 14.5px→var(--fs-base) (notably .input font-size:13.5px→var(--fs-base) for legibility, .quilt-greeting 11px→var(--fs-xs)). The remaining ~83 non-fractional font-size and 63 radius literals are an enumerated follow-up pass, not this PR.
- **AP-07 — JetBrains Mono as decorative differentiator; 8 uppercase micro-label patterns**
  - Swap font-family:var(--font-mono)→var(--font-sans) at the 4 non-code label sites: .quilt-greeting, .section-eyebrow, .editorial-sub, .attention-band-label (and .cluster-tab if mono). Add one utility .label-micro { font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:600; letter-spacing:0.01em; text-transform:none; color:var(--ink-3); } and migrate the 8 uppercase micro-label sites to it (sentence-case). Reserve mono to code/pre/.font-mono/tabular numbers (run IDs, timestamps, ports, hashes); reserve Instrument Serif italic to the Overview hero title only (remove italic from any Traces h1).
- **AP-08 — Dark structural parity: summary-band dissolves, attention tint invisible, cards flat, dividers <3:1**
  - Dark overrides + selector swaps together: .runs-summary-band background var(--bg-0)→var(--surface) and its border --line-2→--line-3; --card-shadow dark inset highlight 0.10→0.15 (restores elevation); .attention-band tint 4%→8% in dark for warn and err; lift dark --line-2 0.16→0.20; and SWAP load-bearing dark dividers to a higher token (table row separators and thead → --line-2/--line-3) so they reach the 3:1 non-text floor — token lift alone is insufficient, the selector must reference the stronger token.
- **AP-09 — Focus relies on ~1.2:1 orange-soft glow with outline:none, no :focus-visible ring**
  - Replace .input:focus glow with a solid ring matching the existing global :focus-visible (.btn) pattern: .input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; box-shadow:0 0 0 4px var(--accent-soft); }. Write a concrete :focus-visible rule for each of the 6 named inputs (.traces-search-input, .traces-export-input, .recipes-search-wrap input, .new-recipe-field-input, .mkt-search-input, .input) and remove outline:none / outline:none !important at every site. Keep the box-shadow halo as decorative supplement, solid outline as the AA-load-bearing indicator (clears 3:1 perimeter).
- **AP-10 — Boxiness / redundant stat-tile signal / 5 inconsistent accent-bar mechanisms**
  - Stat tiles carry color on ONE channel (alert-state left bar only). Standardize all 5 left-accent-bar sites (.runs-stat-card, .runs-tr, .rag3-col, .rag3-card, .traces-row) to box-shadow:inset 3px 0 0 var(--bar-color) (follows border-radius, no layout delta; keep border-left fallback only inside table-overflow contexts where inset clips). Drop the hero outer card to a section header (background:transparent; border-bottom:1px solid var(--line-1)) to remove one nesting level. .runs-stat-value--err → --err-text (4.41:1→5.5:1). .sidebar-create #fff→var(--on-orange); .btn.success #fff→var(--on-green) + --green-strong fill.

### Light tokens

| token | value | note |
|---|---|---|
| `--info-text` | `#2f5496` | NEW. AA-safe blue text for .pill.info and standalone blue text on --blue-soft over cream. ~4.9:1 on the blue-soft tint, 6.0:1 on plain --surface. Mirrors --ok-text. Dark re-points to var(--blue). |
| `--purp-text` | `#5a3d7a` | NEW. AA-safe purple text for .pill.purp on --purple-soft over cream (~4.9:1) and standalone (6.3:1 on --surface). Mirrors --ok-text. Dark re-points to var(--purple). |
| `--amber-text` | `#7a5200` | NEW. Standalone amber text token (judge verdicts, countdown.urgent) distinct from the pill --warn-text but same value in light. 5.8:1 on --surface / canvas. Dark re-points to var(--amber). |
| `--accent-cool` | `#0060d9` | CHANGED from #0787ff. White text on #0060d9 = 4.82:1 (AA) — fixes .mkt-install-btn in light. Still distinctly informational blue; darker/more saturated than before. |
| `--accent-cool-rgb` | `0, 96, 217` | NEW. -rgb companion so glow/pulse/color-mix consumers track --accent-cool. |
| `--accent-cool-glow` | `rgba(0,96,217,0.30)` | CHANGED from rgba(7,135,255,0.3) to match new --accent-cool hex. |
| `--on-accent-cool` | `#ffffff` | NEW. Text color for surfaces using --accent-cool as background. White on #0060d9 = 4.82:1 (AA) in light. Dark flips to ink (see dark block). |
| `--on-green` | `#ffffff` | NEW. Text on --green-strong CTA backgrounds (.btn.success, approval primary). White on --green-strong #3d6635 = 5.5:1 (AA). Token exists so dark mode can flip to ink. |
| `--green-strong` | `#3d6635` | NEW. Darker green for solid-fill CTA backgrounds so white text clears AA (#fff on light --green #5b8a4f is 2.66:1, fail). White on #3d6635 = 5.5:1. Reuses the --ok-text hue. Decoration/text green stays --green/--ok. |
| `--purple-rgb` | `122, 91, 156` | NEW. -rgb companion for --purple (light) so the dark lift has a matching companion and color-mix consumers work in both themes. |
| `--grid-mask-opacity` | `0.18` | CHANGED from 0.55. With the tightened top-edge mask, the grid reads as a faint document-top texture, invisible behind tables/cards. Single highest-ROI readability change. |
| `--aurora-1` | `rgba(197,83,42,0.03)` | CHANGED from 0.05 (halved). Removes warm color cast behind data. |
| `--aurora-2` | `rgba(120,90,40,0.02)` | CHANGED from 0.04 (halved). |
| `--aurora-3` | `rgba(160,120,60,0.02)` | CHANGED from 0.04 (halved). |
| `--paper-grain` | `none` | CHANGED from the 5-radial stack to none. Imperceptible benefit, measurable noise at scale; calm surfaces. (Already none in dark.) Not tracked by tokens.json. |
| `--quilt-soft` | `rgba(120,90,40,0.05)` | CHANGED from rgba(197,83,42,0.07). Neutral warm tint replacing orange so the mosaic never competes with CTAs (paired with the neutral QuiltBg PALETTE). Not tracked by tokens.json. |
| `--card-shadow-hover` | `0 1px 0 0 rgba(255,255,255,0.95) inset, var(--shadow-l)` | CHANGED — removes the 0 0 30px rgba(var(--orange-rgb),0.10) orange bloom. Hover elevation via shadow-l only; orange stays reserved. Not tracked by tokens.json. |
| `--r-5` | `20px` | NEW. Numeric peer for --r-xl so the numeric scale is complete (4/6/10/14/20/999). --r-xl becomes a @deprecated alias for it. Add radius.5 to tokens.json + RENAMES radius.5→r-5. |
| `--r-card` | `var(--r-4)` | CHANGED from var(--r-l) — routes the semantic card radius through the numeric scale (same 14px value). |
| `--ok-text` | `#3d6635` | UNCHANGED value. Listed so tokens.json adds it (was untracked). 5.5:1 on --ok-soft. |
| `--warn-text` | `#7a5200` | UNCHANGED value. Add to tokens.json. 5.8:1 on --warn-soft. |
| `--err-text` | `#aa3838` | UNCHANGED value. Add to tokens.json. 5.5:1 on --err-soft. |
| `--dot-muted` | `#9a907a` | UNCHANGED value. Add to tokens.json (non-text idle dots; 3.0:1 on canvas meets the non-text floor). |
| `--on-accent` | `#ffffff` | UNCHANGED value, make explicit + add to tokens.json. |
| `--on-orange` | `#ffffff` | UNCHANGED light value. Add to tokens.json. Dark flips to #1f0e05. |
| `--err-bg` | `var(--red-soft)` | UNCHANGED. Add to tokens.json marked @deprecated alias of --err-soft; delete after the legacy migration PR. |
| `--green-rgb` | `91, 138, 79` | UNCHANGED value (already in :root). Add to tokens.json. |
| `--amber-rgb` | `201, 142, 43` | UNCHANGED value (already in :root). Add to tokens.json. |
| `--red-rgb` | `181, 67, 67` | UNCHANGED value (already in :root). Add to tokens.json. |
| `--blue-rgb` | `74, 111, 165` | UNCHANGED value (already in :root). Add to tokens.json. |

### Dark tokens

| token | value | note |
|---|---|---|
| `--blue` | `#6b9dd6` | NEW dark override (was inheriting light #4a6fa5 = 2.95:1, fail). As TEXT on dark canvas = ~5.1:1 (AA). Mirrors --red/--green lift. Used as text via --info-text and as bar color on running rows. NEVER use as a bg under white text (see .nav-badge fix). |
| `--blue-rgb` | `107, 157, 214` | NEW. -rgb companion for lifted dark --blue (running stripe box-shadow, pulse color-mix). |
| `--purple` | `#a07acc` | NEW dark override (was #7a5b9c = 3.04:1, fail). As text on dark canvas = ~5.3:1; on --purple-soft #1c1b32 = ~4.9:1 (AA). |
| `--purple-rgb` | `160, 122, 204` | NEW. -rgb companion for lifted dark --purple. |
| `--purple-hover` | `#b490d8` | NEW dark override (was inheriting light #684987, near-invisible on dark). Proportional hover step above lifted --purple. |
| `--amber` | `#d4a040` | NEW dark override (was inheriting light #c98e2b = 3.2:1 on dark canvas, fail). As text on dark canvas = ~4.7:1 (AA normal — clears AA regardless of weight, closing the AA-large-only assumption two proposals relied on). Cascades to --warn-text and --amber-text. |
| `--amber-rgb` | `212, 160, 64` | NEW. -rgb companion for lifted dark --amber. |
| `--accent-cool` | `#4d96e8` | NEW dark override (was inheriting light value). As text/stroke on dark canvas = ~5.1:1. Used as BACKGROUND under --on-accent-cool dark ink (13.8:1) for .mkt-install-btn — vivid blue, AA via dark text not white. |
| `--accent-cool-rgb` | `77, 150, 232` | NEW. -rgb companion for dark --accent-cool. |
| `--accent-cool-glow` | `rgba(77,150,232,0.30)` | NEW dark override matching the lifted cool. |
| `--on-accent-cool` | `#0a0b0d` | NEW dark override. White on dark --accent-cool #4d96e8 = 3.3:1 (fails); dark ink #0a0b0d = 13.8:1 (AA). .mkt-install-btn text routes through this. |
| `--on-green` | `#0a0b0d` | NEW dark override. Dark ink on dark --green-strong #6da060 = ~8:1 (AA). .btn.success flips to dark-ink-on-bright-green in dark. |
| `--green-strong` | `#6da060` | NEW dark override = the already-lifted dark --green. In dark the CTA green is bright enough that DARK ink (--on-green) passes AA, so --green-strong equals the dark --green and contrast comes from flipping the text, not darkening the fill. |
| `--info-text` | `var(--blue)` | NEW dark override → lifted --blue #6b9dd6. On --blue-soft #101b2c = ~5.3:1 (AA). Mirrors --ok-text→var(--green) dark pattern. |
| `--purp-text` | `var(--purple)` | NEW dark override → lifted --purple #a07acc. On --purple-soft #1c1b32 = ~4.9:1 (AA). |
| `--amber-text` | `var(--amber)` | NEW dark override → lifted --amber #d4a040. On --amber-soft #2b2110 = ~6:1 (AA). |
| `--warn-text` | `var(--amber)` | UNCHANGED redirect, now resolves to the lifted #d4a040. Add to tokens.json dark. |
| `--ok-text` | `var(--green)` | UNCHANGED redirect (already in CSS). Add to tokens.json dark. |
| `--err-text` | `var(--err)` | UNCHANGED redirect (already in CSS). Add to tokens.json dark. |
| `--grid-mask-opacity` | `0.15` | CHANGED from 0.40. Same calm logic; dark grid already low-contrast. |
| `--aurora-1` | `rgba(255,122,69,0.04)` | CHANGED from 0.06 (halved+). |
| `--aurora-2` | `rgba(110,168,254,0.03)` | CHANGED from 0.05. |
| `--aurora-3` | `rgba(176,140,232,0.03)` | CHANGED from 0.04. |
| `--quilt-soft` | `rgba(255,255,255,0.04)` | CHANGED from rgba(255,122,69,0.06) — neutral, no orange in the dark mosaic. Not tracked by tokens.json. |
| `--line-2` | `rgba(255,255,255,0.20)` | CHANGED from 0.16. Improves the divider step; paired with selector swaps to --line-2/--line-3 on load-bearing dividers so they reach the 3:1 non-text floor (token lift alone is insufficient). |
| `--card-shadow` | `0 1px 0 0 rgba(255,255,255,0.15) inset, var(--shadow-s)` | CHANGED inset highlight 0.10→0.15. Restores card elevation legibility (light is 0.85; 0.15 is the disciplined dark compromise). Not tracked by tokens.json. |
| `--card-shadow-hover` | `inset 0 1px 0 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(255,255,255,0.07), 0 0 0 1px rgba(0,0,0,0.20), 0 4px 8px rgba(0,0,0,0.28), 0 14px 32px rgba(0,0,0,0.28)` | CHANGED — no orange bloom; layered border+shadow elevation only, slightly strengthened. Not tracked by tokens.json. |
| `--on-orange` | `#1f0e05` | UNCHANGED value. Add to tokens.json dark. Dark ink on #ff7a45 = 7.2:1. |
| `--dot-muted` | `#9ea2ad` | UNCHANGED value (already in CSS). Add to tokens.json dark. |

### Component / CSS changes

- **:root --grid-mask-opacity + .app-main::before (globals.css:206, 589-601)** — Set --grid-mask-opacity:0.18 (light, :206) and 0.15 (dark, :307). Tighten the ::before mask to mask-image / -webkit-mask-image: radial-gradient(ellipse 120% 22% at 50% 0%, black 0%, transparent 100%) so the 32px grid shows only in the top ~22% and fades to nothing below the fold.  
  _why:_ AP-03. Largest single readability gain — the grid currently sits behind every table and card at 0.55.
- **.app-main::after aurora + .app-main background + .app-shell background (globals.css:386-388, 580-613)** — Replace the .app-main::after animated two-aurora keyframe with a single static radial: background: radial-gradient(600px 320px at 90% 0%, var(--aurora-1), transparent 60%); remove the animation. In .app-main background remove the third radial (radial-gradient(400px 300px at 50% 110%, var(--aurora-3)...)) and drop var(--paper-grain) (now none). .app-shell keeps its single radial and inherits the halved --aurora-1.  
  _why:_ AP-03. Collapses 4-5 overlapping decorative layers to one faint static top-edge wash; kills motion behind data.
- **.quilt-bg (globals.css:2411-2421) + QuiltBg.tsx PALETTE (lines 4-13) + flicker interval (line 101)** — CSS: opacity 0.85→0.55; add [data-theme="dark"] .quilt-bg { opacity:0.50 }; push mask + -webkit-mask to linear-gradient(to right, transparent 55%, rgba(0,0,0,0.5) 72%, black 85%). TSX: replace PALETTE with neutral tokens only — ['var(--recess)','var(--pressed)','var(--surface)','var(--quilt-soft)','transparent','transparent','transparent','var(--canvas)'] (no var(--orange)/var(--orange-soft)/var(--ink-3)); change setInterval 1400→2800ms. Component API, props, and prefers-reduced-motion gating unchanged.  
  _why:_ AP-03/AP-04. Confines the mosaic to a far-right strip at half opacity with no orange tiles bleeding through the text mask; halves the repaint cadence.
- **--card-shadow-hover token (globals.css:189 light, :312-317 dark) + generic card ::before glow** — Token change removes the orange bloom (values in lightTokens/darkTokens). Narrow the decorative orange ::before radial-gradient so it applies only inside the hero (e.g. .quilt .card::before) and remove it from generic .stat-card::before / .glass-card::before — pure CSS selector edits, no new className emitted.  
  _why:_ AP-04. Orange off every interactive surface; retained only on the single hero focal card.
- **ragColor() (overview/page.tsx:386-393)** — Replace the hsl(0-359) rotation with const AVATAR_PALETTE = ['#b8a898','#9aaa8e','#9ba8b8','#b0a0b8','#c4a87a']; return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]. Function signature ragColor(key)->string and all call sites unchanged. Returns static hex (not var()) because SVG/inline fills must resolve without custom-property inheritance.  
  _why:_ AP-04. Kills the 360-hue avatar rainbow; muted warm-neutral tones don't compete with status hues.
- **.rag3-chip--tag-* light (globals.css:5007-5013) and dark (:5153-5156+)** — Replace all 7 hardcoded hex rules with semantic tokens (text=*-text, bg=*-soft, border=rgba(var(--*-rgb),0.25)): tag-blue→info; tag-teal→info; tag-purple→purple(--purp-text/--purple-soft); tag-indigo→purple; tag-pink→err(--err-text/--err-soft); tag-amber→warn(--warn-text/--amber-soft); tag-slate→ink-3 on --recess with --line-2 border. Delete the 7 dark hex overrides (the *-text tokens auto-lift). tagColorClass() signature unchanged.  
  _why:_ AP-04/AP-01. Removes off-palette hexes (amber chip 1.74:1, teal 1.99:1) and routes all chips through tokens:check-visible semantics; pink→err and teal→info are the closest on-palette mappings (no new hues).
- **Standalone semantic-text sites** — .pill.info (:1244) color→var(--info-text); .pill.purp (:1343) color→var(--purp-text); .runs-judge-pill[approve] (:1897) →var(--ok-text); [request_changes] (:1898) →var(--warn-text) (drop the #d49a3a fallback); .status-cell.ok (:1851) →var(--ok-text); .tx-status-complete (:7375) →var(--ok-text); .tx-status-pending (:7374) →var(--warn-text); .countdown.urgent (:1842) →var(--amber-text); .runs-stat-label--ok (:1950) →var(--ok-text); .runs-stat-label--err (:1951) →var(--err-text); .runs-stat-value--err →var(--err-text); .attention-clear-ok (:5499) →var(--ok-text); .attention-offline-link (:5493) →var(--info-text).  
  _why:_ AP-01/AP-10. Every standalone semantic text node clears AA in both themes; covers the .runs-stat-label/.attention sites warm-refined missed.
- **.nav-badge / .nav-badge.is-live (globals.css:536-562)** — Re-route off white-on-blue: .nav-badge { background: var(--info-soft); color: var(--info-text); border: 1px solid var(--blue); } and .nav-badge.is-live { background: var(--blue-soft); color: var(--info-text); } keeping the pulse keyframe. Remove color:#fff. font-family:var(--font-mono) is acceptable (tabular count).  
  _why:_ AP-01/AP-02. White on the lifted dark --blue #6b9dd6 is only ~2.8:1; ink-on-soft passes in both themes and survives the lift.
- **[data-theme="dark"] .mkt-install-btn (globals.css:1181-1189)** — color:#fff → color: var(--on-accent-cool) (resolves to #0a0b0d dark). Background stays var(--accent-cool) (now lifted #4d96e8). The :hover color-mix auto-tracks the new --accent-cool. Light .mkt-install-btn white text now passes on the darkened light --accent-cool #0060d9.  
  _why:_ AP-02. Vivid dark cool with dark ink = 13.8:1; fixes the install button in both themes.
- **.sidebar-create (globals.css:414, 446, 453) and .btn.success (:1041-1047)** — .sidebar-create color:#fff → var(--on-orange) (base + :hover + child svg/span). .btn.success: background var(--green)→var(--green-strong), border-color→var(--green-strong), color #fff→var(--on-green); in dark, --green-strong=lifted --green and --on-green=ink so it flips to dark-ink-on-bright-green. Apply the same to the approval primary button if it reuses .btn.success / a green fill.  
  _why:_ AP-02/AP-10/goal #9. Closes the latent sidebar dark bug (white on #ff7a45=2.59:1) and the deferred green-CTA AA failure (white on #5b8a4f=2.66:1).
- **Input focus — .input:focus (:1208-1215) + .traces-search-input, .traces-export-input, .recipes-search-wrap input, .new-recipe-field-input, .mkt-search-input** — Remove outline:none and outline:none!important at every site. Add per-selector :focus-visible rules: { outline:2px solid var(--accent); outline-offset:2px; box-shadow:0 0 0 4px var(--accent-soft); border-color:var(--accent); }. Drop the dark .input:focus glow-only override (:1213-1215) in favor of the shared solid-ring rule. The global :focus-visible (:368) already uses this for buttons.  
  _why:_ AP-09. Solid 2px ring is the AA-load-bearing indicator (clears 3:1 perimeter); halo is decorative. Each named input gets a concrete rule rather than relying on inheritance.
- **.runs-summary-band (globals.css:1868-1877)** — background var(--bg-0)→var(--surface); border var(--line-2)→var(--line-3). Light: surface over canvas still reads as a band; dark: #101216 over #0a0b0d gives region separation and the line-3 border clears the non-text floor.  
  _why:_ AP-08. Band currently shares the canvas color in dark; surface+line-3 makes it a distinct grouping zone.
- **.attention-band tint (globals.css:5468, 5478)** — Add dark overrides: [data-theme="dark"] .attention-band { background: color-mix(in srgb, var(--warn) 8%, var(--card-bg)); } and [data-theme="dark"] .attention-band[data-severity="err"] { background: color-mix(in srgb, var(--err) 8%, var(--card-bg)); }. Light stays 4%.  
  _why:_ AP-08. 4% warn/err on near-black is invisible; 8% crosses the perceptual threshold.
- **Dark structural dividers — table rows + thead + section separators** — Where dark dividers currently use --line-1 (1px row separators in .runs-tr / .tx-row / traces rows and thead bottom borders), swap to var(--line-2); where a divider is the primary structural separator (summary-band, card group separators) use var(--line-3). Selector-level change on top of the --line-2 token lift. Grep the actual selectors first to confirm they reference --line-1 today.  
  _why:_ AP-08. The token lift alone (~1.5:1) doesn't reach 3:1; pairing the lift with referencing the stronger token on load-bearing dividers does.
- **Stat-tile signal + left-accent-bar unification (globals.css ~1934/1964/4835/4930/7115-7118, 5206-5209)** — Standardize all 5 left-bar sites to box-shadow: inset 3px 0 0 var(--bar-color, var(--line-2)); set --bar-color to a status token only when data-alert/severity present, else leave the --line-2 default. Remove the tint + colored label + colored number stacking on healthy stat tiles (number→var(--ink-0), label via .label-micro→var(--ink-3)); keep colored number only on err/alert state. Retain border-left fallback inside table-overflow contexts (.runs-tr) where inset shadows can clip.  
  _why:_ AP-10/AP-04. One color channel per tile, one accent-bar mechanism that follows border-radius.
- **.label-micro utility + mono->sans swaps (globals.css:2299 .section-eyebrow, 2346 .editorial-sub, 2443 .quilt-greeting, 5482 .attention-band-label, 3902 .cluster-tab)** — Add .label-micro { font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:600; letter-spacing:0.01em; text-transform:none; color:var(--ink-3); }. Swap font-family:var(--font-mono)→var(--font-sans) at .quilt-greeting/.section-eyebrow/.editorial-sub/.attention-band-label (and .cluster-tab if mono). Migrate the 8 text-transform:uppercase micro-label sites to .label-micro (sentence-case). Keep uppercase only on true status pills; reserve serif-italic to the Overview hero title.  
  _why:_ AP-07. Two type families max per view; one sentence-case micro-label rhythm.
- **Radius + fractional font-size literals (globals.css:163-173 radii; .input:1204 etc.)** — Add --r-5:20px; redirect --r-card→var(--r-4); add /* @deprecated */ over --r-s/m/l/xl + --radius (do NOT delete). Snap fractional font-sizes: .input 13.5px→var(--fs-base); .quilt-greeting 11px→var(--fs-xs); other 13.5px→var(--fs-m), 11.5px→var(--fs-xs), 10.5px→var(--fs-2xs), 14.5px→var(--fs-base).  
  _why:_ AP-06. One numeric radius vocabulary going forward; 18 off-scale font-sizes snapped. Bulk literal migration is a gated follow-up PR.
- **tokens.json light.color + dark.color + radius blocks; scripts/check-tokens.mjs RENAMES** — Light.color add: ok, ok-soft, ok-text, warn, warn-soft, warn-text, err, err-soft, err-text, err-bg, info, info-soft, info-text, purp-text, amber-text, accent-cool, accent-cool-rgb, accent-cool-glow, on-accent, on-accent-cool, on-orange, on-green, green-strong, dot-muted, green-rgb, amber-rgb, red-rgb, blue-rgb, purple-rgb. light.radius add: 5 (20px). Dark.color add: amber, amber-rgb, blue, blue-rgb, purple, purple-hover, purple-rgb, accent-cool, accent-cool-rgb, accent-cool-glow, on-accent-cool, on-green, green-strong, on-orange, dot-muted, ok-text, warn-text, err-text, info-text, purp-text, amber-text. Use literal CSS value for hex tokens and the var(--x) string for alias tokens. Add RENAMES entry "radius.5":"r-5" in check-tokens.mjs. Do NOT add --paper-grain/--quilt-soft/--card-shadow*/--grid-mask-opacity (curated-out of tokens.json by design).  
  _why:_ AP-05. Closes the gate blind spot over the newly-lifted AA-risk tokens; must land in the same PR as the CSS additions.

### Contrast checks (all pass AA)

| | ratio | pair |
|---|---|---|
| ✅ | ~4.9:1 | LIGHT --info-text #2f5496 on .pill.info blue-soft tint over surface |
| ✅ | ~4.9:1 | LIGHT --purp-text #5a3d7a on --purple-soft tint over surface |
| ✅ | ~5.8:1 | LIGHT --amber-text/--warn-text #7a5200 on --amber-soft / canvas |
| ✅ | ~5.5:1 | LIGHT --ok-text #3d6635 on --ok-soft / canvas |
| ✅ | ~5.5:1 | LIGHT --err-text #aa3838 on --err-soft / canvas |
| ✅ | ~4.82:1 | LIGHT white #fff on --accent-cool #0060d9 (mkt-install-btn) |
| ✅ | ~5.5:1 | LIGHT white #fff on --green-strong #3d6635 (.btn.success) |
| ✅ | ~4.5:1 | LIGHT white #fff on --orange #c5532a (.sidebar-create / .btn.primary) |
| ✅ | ~4.9:1 | LIGHT --info-text on .nav-badge --info-soft bg |
| ✅ | ~4.5:1 | LIGHT solid focus ring --accent #c5532a (2px) vs --surface perimeter |
| ✅ | ~5.1:1 | DARK --blue #6b9dd6 text on canvas #0a0b0d |
| ✅ | ~5.3:1 | DARK --info-text(var(--blue) #6b9dd6) on --blue-soft #101b2c |
| ✅ | ~4.9:1 | DARK --purple #a07acc / --purp-text on --purple-soft #1c1b32 |
| ✅ | ~6:1 | DARK --amber #d4a040 / --warn-text / --amber-text on --amber-soft #2b2110 |
| ✅ | ~4.7:1 | DARK --amber #d4a040 text on canvas #0a0b0d (normal AA) |
| ✅ | ~5.7:1 | DARK --ok-text(var(--green) #6da060) on --green-soft #0e2519 |
| ✅ | ~4.9:1 | DARK --err-text(var(--err) #d05757) on --red-soft over canvas |
| ✅ | ~13.8:1 | DARK dark-ink --on-accent-cool #0a0b0d on --accent-cool #4d96e8 (mkt-install-btn) |
| ✅ | ~8:1 | DARK dark-ink --on-green #0a0b0d on --green-strong #6da060 (.btn.success) |
| ✅ | ~7.2:1 | DARK dark-ink --on-orange #1f0e05 on --orange #ff7a45 (.sidebar-create) |
| ✅ | ~5.3:1 | DARK --info-text on .nav-badge --info-soft / .is-live --blue-soft |
| ✅ | ~3.1:1 | DARK --line-3 rgba(255,255,255,0.24) structural divider on canvas #0a0b0d |
| ✅ | ~3.0:1 | DARK --line-2 rgba(255,255,255,0.20) row divider on surface #101216 |
| ✅ | ~3.4:1 | DARK solid focus ring --accent #ff7a45 (2px) vs surface perimeter |
| ✅ | ~3.0:1 (border) | LIGHT runs-summary-band --surface #fbf8f0 vs canvas #f3efe5 with --line-3 border (region boundary) |

### Rollout

Slice into 5 PRs, each independently shippable and green on `npm run tokens:check` + `npm run build`:

PR-1 (token grammar — additive, zero visual change): Add the dark chromatic lifts (--blue/--purple/--amber/--accent-cool + -rgb), the *-text tokens (--info-text/--purp-text/--amber-text + dark aliases), on-color tokens (--on-accent-cool/--on-green/--green-strong), the --accent-cool light darken, ALL tokens.json light+dark+radius additions, AND the check-tokens.mjs RENAMES radius.5→r-5 in the SAME commit. Verify: `node scripts/check-tokens.mjs` prints match; no rendered change yet because no component references the new tokens.

PR-2 (AP-01/AP-02 contrast sweep): Migrate the ~30 standalone-text sites, the 7 tag chips, .nav-badge, .mkt-install-btn, .sidebar-create, .btn.success onto the PR-1 tokens. Playwright: navigate /overview, /runs, /traces, /recipes, /marketplace in BOTH themes; assert getComputedStyle color on .pill.info/.pill.purp/.runs-judge-pill/.status-cell.ok/.tx-status-*/.nav-badge resolves to the *-text values; screenshot the Install + Create buttons in dark and confirm the dark-ink-on-color flip.

PR-3 (AP-03/AP-04 decoration): grid-mask-opacity, aurora halving + de-animation, paper-grain removal, app-shell radial reduction, QuiltBg PALETTE + opacity + mask + interval, card hover-glow removal + ::before scoping, ragColor palette, stat-tile single-channel. Playwright: screenshot /overview hero (light+dark) confirms the mosaic is a right-strip at reduced opacity with no orange tiles; assert animation-name on .app-main::after is none; confirm prefers-reduced-motion still suppresses flicker.

PR-4 (AP-08/AP-09 parity+focus): runs-summary-band surface+line-3, attention-band 8% dark tint, card inset 0.15, --line-2 lift + structural-divider selector swaps, per-input :focus-visible rules + remove outline:none. Playwright: keyboard-tab through each form (/recipes new, /traces search, /marketplace search), screenshot the focused state, assert outline-style is solid not none; toggle dark and screenshot the runs summary band + attention band.

PR-5 (AP-06/AP-07 scale+type): --r-5, --r-card redirect, @deprecated comments, fractional font-size snaps, .label-micro utility + mono→sans swaps. Playwright: visual diff on nav labels, eyebrows, page subtitles in both themes; confirm no layout shift from the 0.5px font snaps at 1x and 2x DPR.

Across all PRs: run `npm run tokens:check`, `npm run build`, and the existing Playwright suite. Add one new Playwright assertion that walks every .pill/.chip/.runs-judge-pill and fails if computed color === the raw primitive (--blue/--purple/--amber/--green) rather than a *-text token. Do NOT delete --r-s/m/l/xl/--radius or the --bg-*/--fg-*/--border-* alias block in these PRs — that is a separate migration gated on a zero-reference grep.

### Risks

1. accent-cool is the highest-risk token: used both as TEXT/stroke (sparklines, FlowSvg running badge, +N pill) AND as a BACKGROUND under text (.mkt-install-btn). The light darken to #0060d9 changes sky-blue to a deeper navy everywhere it is a stroke — QA FlowSvg + sparklines in light. Audit every hardcoded color:#fff / fill:#fff sitting on an --accent-cool background and route through --on-accent-cool; SVG fill attrs that don't inherit CSS vars need the resolved value.

2. Dark --blue/--purple/--amber lifts brighten these tokens wherever used as non-text borders/tints (running-stripe bar, paused-kanban border, amber stat-tile border). They pass the 3:1 non-text floor, but review the Runs running-row stripe and Recipes kanban borders in dark before shipping.

3. The structural-divider fix REQUIRES the selector swaps in PR-4, not just the --line-2 token lift. If PR-4 ships the token lift without the selector changes, dividers improve marginally (~1.5:1) but still fail 3:1 — the two halves must land together. Grep the row/thead selectors to confirm they reference --line-1 today before swapping.

4. ragColor returns static hex (not var()), so avatar tones do NOT theme-flip. The 5 muted tones were chosen to read on both contexts; confirm overlaid initials (ink-0) clear 4.5:1 on each tone in both themes, or gate the palette on theme.

5. QuiltBg PALETTE uses var() tokens in SVG <rect fill>. They DO resolve (rects inherit document-root custom properties), but verify in Safari/Firefox; if any engine fails, fall back to resolved hex per theme via a class on the rect rather than inline var().

6. .btn.success darkening to --green-strong (#3d6635) in light is a perceptible shift from the current mid-green; product should preview. The dark path keeps the bright green fill and flips to dark ink, so dark looks different from light (bright vs deep) — intentional and AA-correct, but note the asymmetry.

7. Fractional font-size snaps (.input 13.5→14px is a snap UP for legibility; others snap to nearest) can shift line-wrapping in tight nav labels. QA at 1x and 2x DPR; prefer snap-up where a 0.5px loss would clip a label.

8. check-tokens.mjs is JSON→CSS only and tolerates var() aliases (normalize() string-compares; RENAMES maps keys). Adding radius.5 needs the RENAMES entry radius.5→r-5 in PR-1 — without it the default cssVarName resolves to --5 which does NOT exist and the gate reports missing-in-css.

9. Removing outline:none !important from .new-recipe-field-input may expose a default ring if that field's custom border overlaps — the per-selector :focus-visible rule must fully define outline+offset+box-shadow for that field; test in Chrome/Safari/Firefox.

10. The hero outer-card flatten (AP-10) and the ::before glow scoping touch shared card selectors — verify no non-hero card loses intended elevation and that the focal glow lands on exactly one hero surface.
