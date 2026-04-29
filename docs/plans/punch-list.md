# Unified Punch List — 2026-04-29

Source: holistic merge of [dashboard-fix-plan.md](./dashboard-fix-plan.md) (DB-),
[visual-recipe-debugger.md](./visual-recipe-debugger.md) (VD-),
[../dogfood-findings-2026-04-29.md](../dogfood-findings-2026-04-29.md) (DF-),
[../recipe-authoring-wave2-plan.md](../recipe-authoring-wave2-plan.md) (W2-),
[../recipe-schemastore-pr.md](../recipe-schemastore-pr.md) (SS-),
[ai-recipe-builder.md](./ai-recipe-builder.md) (AI-),
recent merged PRs (#37–#54), memory `project_immediate_actions.md` + `project_2026-04-28_merged_prs.md`.

---

## Next 5 actions in order

1. **DB-1** $schema URL + manifest 404s (30 min, ships today)
2. **DB-3** RecipeRunLog read-on-miss (parallel w/ DB-1, unblocks debugger)
3. **DB-2** /api/bridge/* proxy diagnosis + fix (unblocks Connections, Runs detail, VD-1)
4. **DB-5** CLI/bridge-startup race (must land before DB-4 — same-file collision)
5. **DB-4** `recipe run` install-dir resolution (after DB-5)

---

## Quick wins (< 1h, high impact)

| ID | Description | Sev | Eff | Depends | Source |
|---|---|---|---|---|---|
| DB-1 | Swap `$schema` URL in `dashboard/src/app/recipes/new/page.tsx:110` + `templates/recipes/project-health-check.yaml` + `dashboard/public/schema/recipe.v1.json` `$id`; add favicon/manifest stubs | HIGH | S | — | DB plan PR #1, DF HIGH-B |
| DB-6a | Marketplace empty-state copy; coalesce NaN→"—" in analytics; clamp recipe descriptions to 2 lines | MED | S | — | DB PR #6a, DF HIGH-C/MED-C/MED-F |
| MEM-1 | Drop 5 dead feature flags (`FLAG_DEBUGGER`, `FLAG_CLI_UX`, `FLAG_MOCK_HARNESS`, `FLAG_WAVE2_CONNECTORS`, `FLAG_COMMUNITY_GALLERY`) | LOW | S | — | merged-PR #40 already shipped — VERIFY done |
| MEM-2 | Stale `apiCall()` typing — `string \| undefined` → `string` on callback param | LOW | S | — | memory `project_2026-04-28_merged_prs.md` (note: PR #41 already shipped this — confirm) |
| DF-LOW | Hardcoded "Good morning"; duplicate top-nav vs sidebar; two `daily-status` recipes display ambiguity | LOW | S | DB-2 | DF Low section |

---

## Foundational (must ship before later work)

| ID | Description | Sev | Eff | Depends | Source |
|---|---|---|---|---|---|
| DB-2 | `/api/bridge/*` Next.js 404s on every endpoint — likely stale `.next` build; verify hypothesis ladder, ship rebuild + dev-warning | CRIT | M | — | DB PR #2, DF CRIT-B/HIGH-D — **gates VD-1, Connections page, Runs detail** |
| DB-3 | `RecipeRunLog.getBySeq` read-on-miss for older seqs (>500 ring cap) | HIGH | M | — | DB PR #3, DF CRIT-B (paired) — independent of DB-2 per structural review |
| DB-5 | Gate `bridge.start()` on subcommand sentinel in `src/index.ts:2677` | HIGH | M | — | DB PR #5, DF HIGH-F — **before DB-4** (same-file collision) |
| DB-4 | `/recipes/run` bridge handler → use `findYamlRecipePath` for install-dir traversal | HIGH | M | DB-5 | DB PR #4, DF HIGH-E |
| DB-7 | Playwright sidebar-walk + `/api/bridge/runs` proxy smoke test in CI | MED | M | DB-1, DB-2 | DB PR #7 |
| IMM-1 | Deploy dashboard to patchworkos.com (`bash deploy/deploy-dashboard.sh`) | HIGH | S | DB-1, DB-2 | memory `project_immediate_actions.md` |
| SS-1 | Confirm SchemaStore #5608 LGTM landed; once merged, update `$schema` headers in `examples/recipes/*.yaml` to canonical SchemaStore URL | MED | S | — | recipe-schemastore-pr.md |

---

## Investments (multi-day, payoff later)

| ID | Description | Sev | Eff | Depends | Source |
|---|---|---|---|---|---|
| VD-1 | Phase 1: live-tail SSE — wire `onStepStart`/`onStepComplete` in `recipeOrchestration.fireYamlRecipe`, dashboard subscribes via `useBridgeStream` | HIGH | M | DB-2, DB-3 | VD plan Phase 1 (~110 LOC) |
| VD-2 | Phase 2: per-step capture (`resolvedParams`, `output`, `registrySnapshot`) on `RunStepResult` w/ 8KB cap + sensitive-key redaction | MED | M | VD-1 | VD plan Phase 2 (~150 LOC) |
| VD-3 | Phase 3: registry-diff hover (`GET /runs/:seq/steps/:stepId/diff` + `<HoverPanel>` primitive) | MED | M | VD-2 | VD plan Phase 3 (~200 LOC) |
| VD-4 | Phase 4: replay endpoint + mocked/real mode UX (deferrable indefinitely if side-effect risk too thorny) | MED | L | VD-2, kill-switch (#38 shipped) | VD plan Phase 4 (~300 LOC) |
| W2-A0 | OAuth refresh test coverage — per-Wave-2-connector refresh tests + direct `BaseConnector.refreshToken()` unit test | MED | M | — | W2 plan A0 "Remaining gap" |
| W2-A4 | Per-connector fixture libraries for every Wave 1 + Wave 2 provider (record-and-replay) | MED | L | W2-A0 | W2 plan A4 |
| W2-A5 | Wave 2 connectors remaining: Zendesk, Intercom, HubSpot, Datadog, Stripe (read-only). Confluence + Notion already shipped | HIGH | L | W2-A0 | W2 plan A5 |
| AI-1 | AI Recipe Builder tab on `/recipes/new` — Vercel AI SDK + voice + YAML→FormState | MED | M (~1 day) | DB-1, DB-2 | ai-recipe-builder.md |
| DB-6b | Stat-window labels; `formatDuration` helper; `recipe new --out` flag/cwd-aware msg; clarify Sessions count | MED | M | — | DB PR #6b, DF MED-A/B/D/E |
| ROC-1 | RecipeOrchestrator extraction phase 2 — recipe scheduler wiring (`bridge.ts:982-990`) + recipe HTTP fns (`bridge.ts:1235-1280`) → `src/recipeOrchestration.ts` | MED | M | — | memory `project_recipe_orchestrator.md` (Phase 1 landed 2026-04-25) |
| LRC-1 | Decide fate of `legacyRecipeCompat.ts`; schedule removal post-migration | LOW | M | — | memory `project_immediate_actions.md` #5 |

---

## Hidden dependencies / parallelization

- **DB-1 + DB-3 + DB-7** can land in parallel — different files, no coupling.
- **DB-2 blocks VD-1, IMM-1, AI-1, Connections page** — highest-leverage unblock.
- **DB-5 must precede DB-4** — both touch `src/index.ts` subcommand dispatch.
- **VD-1 is gated on DB-2 (proxy) + DB-3 (older-seq read)** per dashboard-fix-plan addendum line 238.
- **W2-A5 (remaining Wave 2 connectors) gated on W2-A0** — refresh-test coverage must land before merging more connectors.
- **AI-1 needs DB-1+DB-2** — calls dashboard API routes, won't work with broken proxy.
- **SS-1 unblocks editor-distribution finalization** — independent of everything else.

---

## Plan-vs-merged-PR cross-check (gaps spotted)

- **MEM-1, MEM-2** — memory file `project_2026-04-28_merged_prs.md` flags `featureFlags.ts` cleanup + `apiCall()` typing as "TODO". Merged commits show `#40` (5 unused flags removed) + `#41` (apiCall typing) **already shipped** 2026-04-28. **Verify, then prune memory note.**
- **PR #46** (path-traversal fixes), **#48** (refreshToken hardening), **#52** (`recipe uninstall`), **#53** (kill-switch env reads at startup), **#54** (scheduler parse errors + TOCTOU) — all merged but not referenced in any plan doc. Indicates plans drift fast; **add a "recent shipped" check at the top of each plan**.
- **DF Note line 7** — globally-installed `patchwork` CLI lags main (missing PR #52). User-facing onboarding break; suggest `npm install -g @latest` step in install docs.
- **Missing from all plans:** dashboard deployment to production (`deploy/deploy-dashboard.sh`) is blocked on user confirmation only — captured here as **IMM-1**.

---

## Recommended week-2 view (after DB-1..7 ship)

Once dashboard fixes land (1–2 days):

1. **VD-1 (live-tail)** — highest user-visible value, low risk, unblocked by DB-2/DB-3.
2. **W2-A0 (refresh test coverage)** in parallel — prerequisite for any Wave 2 connector merge.
3. **AI-1 (AI Recipe Builder)** — ~1 day, high demo value, parses cleanly into existing `FormState`.
4. **IMM-1 (deploy dashboard)** — one-command deploy once DB-1/DB-2 verified locally.
5. **VD-2 → VD-3** sequentially (Phase 2 storage → Phase 3 hover) over week 3.
6. **W2-A5 connectors** roll in serially once W2-A0 lands, one connector/PR.

---

## Out of scope (defer / drop)

| ID | Reason |
|---|---|
| **VD-4 (replay)** | Side-effect risk + auth implications; Phases 1–3 deliver substantial debugger value alone. Re-evaluate after Phase 3 ships. |
| **AI Builder voice input** (subset of AI-1) | Browser-native `SpeechRecognition`; ship after textarea path stable. Firefox unsupported is acceptable. |
| **W2 Stripe write actions** | Explicitly deferred to financial-actions milestone (compliance + audit-log retention separate review). |
| **M5 community ecosystem** (B1/B2/B3) | Gated on M4.5 stabilizing (A0/A1/A2). Premature without GitHub-backed install + signing infra. |
| **M6 custom registry / ratings / monetization** | Not on roadmap horizon. |
| **`patchwork 2.0/` prototype dir** | Untracked, no coupling — leave as-is per memory `project_immediate_actions.md` #5. |
| **AI-builder migration backlog** (Community page, Roadmap page, CommandPalette, Onboarding) | ~138 story points; pick one Tier-1 item (AI Builder) for now, defer rest. |
| **DB-6b Sessions counter relabel** if it turns out MCP sessions are intentionally excluded | Document the choice in tooltip, don't expand the count. |

---

## Bottom line

**~12 actionable items + 4 investment tracks.** Quick wins (DB-1, DB-6a) ship today; foundational fixes (DB-2..5) consume 1–2 days; week-2 unlocks the visual-debugger Phase 1 + Wave 2 connector test coverage in parallel. Defer M5 ecosystem work; defer VD-4 (replay) until Phase 3 ships.
