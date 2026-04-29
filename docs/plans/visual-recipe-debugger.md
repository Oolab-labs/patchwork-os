# Visual Recipe Debugger — Phased Implementation Plan

**Status:** Plan — not started
**Author / origin:** synthesized from frontend + backend audits 2026-04-29
**Goal:** Turn the read-only `/runs/[seq]` page into an interactive debugger with live-tail, per-step replay, and registry-diff hover.
**Audit reference:** "Visual debugger replay + live-tail" was the largest remaining UX gap from the 2026-04-28 roadmap audit.

---

## TL;DR

The dashboard timeline at `dashboard/src/app/runs/[seq]/page.tsx` already renders steps and assertion failures, but it polls every 3s and supports no interaction. Three features deliver the "real debugger" experience:

1. **Live-tail** — events stream as the recipe runs (SSE).
2. **Registry-diff hover** — see how each step changed the output registry.
3. **Replay** — re-run a single step or from a step (with side-effect mode toggle).

**Order matters.** Live-tail unlocks the per-step event channel that diff and replay both rely on.

| Phase | Feature | Effort | Risk | Builds on |
|---|---|---|---|---|
| 1 | Live-tail (broadcast existing chainedRunner hooks) | S (~30 LOC bridge, ~80 LOC dashboard) | Low | nothing new |
| 2 | Per-step capture (resolved params + registry snapshot) | M (~150 LOC) | Medium (storage size) | nothing new |
| 3 | Registry-diff hover | M (~200 LOC + new HoverPanel primitive) | Low | Phase 2 |
| 4 | Replay step / replay from step | L (~300 LOC + UX for side-effect mode) | High (real-tool side effects) | Phase 2 |
| 5 | Polish + docs | S | Low | all of the above |

---

## What exists today (verified)

### Frontend — `dashboard/src/app/runs/[seq]/page.tsx`

- 649-line client component, plain useState + useEffect + fetch.
- 3-second polling loop (lines 386–419) only while `run.status === "running"`; clears on terminal status.
- Five panels: sticky header (450–503), tab bar (511–518), steps tab with `AssertionFailuresPanel` + `StepRow`s (521–565), plan tab with lazy-loaded `PlanView` (568–596), meta card (599–644).
- Consumes two endpoints: `GET /api/bridge/runs/:seq` → `runDetailFn` (`src/server.ts:2194`); `GET /api/bridge/runs/:seq/plan` → `runPlanFn` (`src/server.ts:2220`).
- Dashboard SSE pattern is **already established** — `dashboard/src/hooks/useBridgeStream.ts` (EventSource + 3s reconnect), used by `activity/page.tsx:87,114` and `approvals/page.tsx:492–546`. Proxy route `dashboard/src/app/api/bridge/[...path]/route.ts` is SSE-aware.
- Styling: plain CSS variables in `globals.css`, no shadcn / Tailwind. **No HoverCard primitive exists** — must build from `.card` + `.mono` (~60 LOC).

### Backend

- **`RecipeRunLog`** (`src/runLog.ts:28-62`): per-run JSONL, in-memory ring (cap 500), `query()` + `getBySeq()`. Per-step shape `{id, tool?, status, error?, durationMs}` — **no input params, no output data, no resolved templates**.
- **`RecipeOrchestrator`** (`src/recipes/RecipeOrchestrator.ts:43-97`): tiny dedup wrapper, no event emitter; `fire()` is fire-and-forget.
- **`chainedRunner.ts`** — already has `onStepStart(stepId)` + `onStepComplete(stepId, error?)` hooks plumbed through `RunOptions` → `ExecutionOptions` → `executeWithDependencies` (`chainedRunner.ts:69-70, 587-588`; `dependencyGraph.ts:25-26, 171-193`). **Hooks exist but `fireYamlRecipe` doesn't wire them** (`recipeOrchestration.ts:322-327`).
- **`outputRegistry.ts`**: `Map<stepId, StepOutput>` where `StepOutput = {status, data, metadata?}`. Set overwrites; no history. Registry is destroyed when run ends (`chainedRunner.ts:548` — local var).
- **HTTP**: `GET /runs`, `/runs/:seq`, `/runs/:seq/plan`. No streaming run endpoint.
- **SSE infrastructure**: bridge serves `GET /stream` (`server.ts:985-1030`) backed by `ActivityLog.subscribe` (`activityLog.ts:60-63`); pattern is `text/event-stream` + 15s heartbeat + 20-subscriber cap. Same pattern at `/approvals/stream`. **This is the right extension point.**

---

## Phase 1 — Live-tail (S, ~110 LOC total)

**Goal:** Steps appear on the timeline as they run, without page refresh, with no schema changes.

### Bridge changes

1. **Wire the existing hooks.** `recipeOrchestration.fireYamlRecipe` at `src/recipeOrchestration.ts:322` builds `chainedOptions` but doesn't set `onStepStart` / `onStepComplete`. Add two callbacks that call `bridge.activityLog.recordEvent(kind, payload)`:
   ```ts
   onStepStart: (stepId) => activityLog.recordEvent("recipe_step_start", {
     recipeName, runSeq, stepId, ts: Date.now(),
   }),
   onStepComplete: (stepId, error) => activityLog.recordEvent("recipe_step_done", {
     recipeName, runSeq, stepId, status: error ? "error" : "ok",
     error: error?.message, ts: Date.now(),
   }),
   ```
2. **Extend ActivityLog event kinds.** New kinds `recipe_step_start` / `recipe_step_done` (no schema migration needed — events are JSON blobs).

### Dashboard changes

3. **Subscribe via existing `useBridgeStream` hook** in `runs/[seq]/page.tsx`. When `run.status === "running"`, replace the 3s polling loop with the stream subscription. Filter incoming events by `kind in {recipe_step_start, recipe_step_done}` and `runSeq === seq`. Append to local step state.
4. **Fall back to polling for terminal-state runs** (no stream available; existing path stays).

### Tests

- Bridge: unit test the wiring — fire a recipe with mocked ActivityLog, assert events recorded with correct kinds + runSeq.
- Dashboard: smoke test against a seeded run-in-progress fixture.

### Why this first

- **No schema changes**, no new endpoints, no migration. Pure plumbing.
- Establishes the per-step event channel that Phases 3 + 4 reuse.
- User-visible value: timeline updates in real time. The most-asked debugger feature.

### Risks

- ActivityLog is global. Many subscribers see all events. Filter on dashboard side (cheap). If noise becomes a problem, Phase 1.5 is to add a dedicated `GET /runs/:seq/stream` server endpoint that pre-filters.

---

## Phase 2 — Per-step capture (M, ~150 LOC)

**Goal:** Persist enough per-step state that registry-diff and replay are feasible. Pure data-layer change with no UI.

### Schema

Add a new optional field to `RunStepResult` (`src/runLog.ts:20-26`):

```ts
interface RunStepResult {
  id: string;
  tool?: string;
  status: "ok" | "skipped" | "error";
  error?: string;
  durationMs: number;
  // NEW (all optional — backwards compatible with existing runs.jsonl):
  resolvedParams?: unknown;        // params after template substitution
  output?: unknown;                // step output data (capped at 8KB JSON-stringified)
  registrySnapshot?: Record<string, unknown>;  // registry keys → output data, after this step
  startedAt?: number;
}
```

### Capture site

`chainedRunner.ts:634` (`registry.set(stepId, ...)`) is the single observation point. After write, snapshot `registry.summary()` plus the new step's resolved params + output. Cap each field at 8KB JSON to avoid bloat (large outputs truncate to `…[truncated]`).

### Storage

The existing `runs.jsonl` already stores `stepResults`. Append the new fields there — no new file needed. Existing rows that don't have the fields render with disabled diff/replay buttons (graceful degradation).

### Tests

- Snapshot is captured (existsing chainedRunner tests can extend).
- 8KB cap is honored.
- Older runs.jsonl (no snapshots) parses without error.

### Risks

- `runs.jsonl` size grows. With the 8KB-per-step cap and 500-run ring buffer, worst case is ~500 × ~10 steps × 8KB = ~40MB. Acceptable; document the size envelope.
- Sensitive data in `resolvedParams` (API keys in headers, etc.). Mitigation: redact known sensitive keys (`authorization`, `cookie`, `x-api-key`, `password`, `secret`, `token`) before write. Reuse existing redactor from logger.ts if present; otherwise add a small helper.

---

## Phase 3 — Registry-diff hover (M, ~200 LOC + new primitive)

**Goal:** Hover any step row → see exactly how that step changed the output registry.

### Backend

5. **New endpoint** `GET /runs/:seq/steps/:stepId/diff` returning `{added: {}, modified: {}, removed: []}`. Computed from Phase 2's `registrySnapshot` (this step) minus the previous step's snapshot. Server-side compute is cheap (in-memory).
6. **Optional bonus**: include the diff inline on `/runs/:seq` so no second request is needed. Add `registryDiff?: RegistryDiff` to `RunStepResult`.

### Frontend

7. **New `<HoverPanel>` primitive** in `dashboard/src/components/HoverPanel.tsx` (~60 LOC). Anchors to a parent row, escapes on Escape, click-outside, or mouseleave.
8. **`StepRow` extension** (`page.tsx:142-242`): on `onMouseEnter` after a 200ms delay, show the panel with three sections: `+ Added (N)`, `~ Modified (N)`, `− Removed (N)`. Each row: monospaced key + value (truncated at 200 chars).
9. **Empty-state**: "No registry changes from this step" if all sections empty (e.g., agent steps that don't write to the registry).

### Tests

- Backend: snapshot-diff tests (added / modified / removed each in isolation, then combined).
- Frontend: hover-panel renders, dismisses on Escape.

### Risks

- Diff payload size could be large for steps that wrote big outputs. Frontend caps at 50 changes shown + "and N more"; backend caps at 100KB total response.
- Older runs without `registrySnapshot` show a "Step diff unavailable for runs created before vX.Y" message.

---

## Phase 4 — Replay (L, ~300 LOC + side-effect mode UX)

**Goal:** Re-run a single step or from a step. The most-asked debugging feature, also the most dangerous.

### The side-effect problem

Recipe steps run real tools — `slack.post_message`, `github.createIssue`, `file.write` — that have external side effects. Naive replay = double-message Slack channel. Need an explicit user choice.

### UX

10. **Two replay buttons** on each step row:
    - **`Replay (mocked)`** — run with a `MockConnector` for every connector tool. Read tools (no isWrite) call the real backend; write tools return the captured output from the original run.
    - **`Replay (real)`** — confirmation dialog ("This will re-execute side effects against connected services. Continue?"), then runs against real connectors.
11. **`Replay from step N`** at the top — replays step N onward with the recipe's full state reconstructed from earlier steps' outputs (Phase 2 capture).

### Backend

12. **New endpoint** `POST /runs/:seq/replay` body `{fromStepId: string, mode: "mocked" | "real"}`. Returns a new run seq.
13. **Replay implementation** in `chainedRunner.ts` — extend `executeWithDependencies` with a `startFromStepId` parameter and a pre-populated `OutputRegistry` (from the original run's snapshots). Existing dependency-graph traversal handles "skip steps before N" naturally — they're already complete.
14. **Mocked mode** wraps connectors in `MockConnector` (already exists at `src/connectors/mockConnector.ts`) seeded from the captured outputs.

### Tests

- Replay-from-step preserves prior outputs.
- Mocked mode doesn't fire real network calls.
- Real mode requires explicit body field; missing field → 400.

### Risks (real)

- **Auth required**: replay endpoint must be authenticated (bearer or session). Today `/runs/:seq` is read-only on the dashboard surface; this is the first write endpoint on this path. Match existing approval / write-tier auth pattern.
- **Kill switch interaction**: replay with real-mode write tools must respect the `KILL_SWITCH_WRITES` flag (already wired into `executeTool`).
- **Audit log**: each replay enters runs.jsonl as a fresh run. Add `triggerSource: "replay:<originalSeq>:<stepId>"` so the trail is clear.

### Risks (out-of-scope)

- Streaming replay output back to the user (would tie back to Phase 1's stream). For v1, replay-then-redirect-to-new-run-page is fine.

---

## Phase 5 — Polish + docs (S)

15. **Documentation**: update `documents/platform-docs.md` with the new endpoints + feature description.
16. **Keyboard shortcuts**: `R` to focus replay button on selected step; `Escape` to dismiss hover.
17. **Empty-state messaging**: "Live-tail not available — run is complete" / "Replay unavailable for runs older than vX.Y".
18. **`recipe enable/disable` interaction**: replaying a disabled recipe should require explicit `--force` or be blocked entirely. Decide which (block by default, IMO).

---

## Open questions (decide before starting)

1. **Live-tail channel — broad `/stream` filtered client-side, or dedicated `/runs/:seq/stream`?** Backend audit says broad is simpler (no new endpoint). Frontend audit says dedicated is cleaner (less noise, easier filter at server). **Recommendation:** start broad (Phase 1), promote to dedicated if dashboard runs into noise (Phase 1.5). Cost of promotion is small.

2. **Replay scope — single step only, or full re-run from step?** "Full re-run from step" is more useful and only marginally harder once Phase 2 capture exists. **Recommendation:** ship "from step" by default; "single step only" is a special case (`startFromStepId === lastStepId`).

3. **Sensitive-data redaction in capture** — what's the redaction policy? Simple key-pattern allowlist vs. structural (e.g., redact anything inside an `auth.*` field). **Recommendation:** start with key-pattern allowlist for v1; structural redaction is Phase 2.5 if it's needed.

4. **Older runs without snapshots** — graceful degradation (disabled buttons + tooltip) vs. backfill on read. **Recommendation:** graceful degradation only. Backfill is impossible without re-running.

---

## Test strategy

| Phase | Tests added | Notes |
|---|---|---|
| 1 | ~6 (3 bridge wiring, 3 dashboard subscribe) | Bug-fix protocol applies — write a failing test that verifies polling is replaced when stream is available |
| 2 | ~10 (capture happy path, 8KB cap, redaction, backwards compat) | Existing chainedRunner tests cover most of the surface |
| 3 | ~8 (diff math + hover panel) | New HoverPanel component tested in isolation |
| 4 | ~12 (replay mocked + real, kill-switch interaction, auth, audit log) | Highest-stakes phase; deserves the most coverage |
| 5 | ~4 (a11y, keyboard nav) | Mostly visual — manual smoke acceptable |

Total: ~40 new tests across 5 PRs.

---

## Recommended PR sequence

| PR | Title | Phase |
|---|---|---|
| A | feat(recipes): live-tail step events via SSE | 1 |
| B | feat(runlog): capture per-step inputs + outputs + registry snapshot | 2 |
| C | feat(dashboard): registry-diff hover on step rows | 3 |
| D | feat(recipes): replay endpoint + mocked/real mode | 4 (backend) |
| E | feat(dashboard): replay button + side-effect confirmation | 4 (frontend) |
| F | docs + polish | 5 |

Each PR is independently merge-able. PR D could be skipped or deferred indefinitely if the side-effect risk turns out to be too thorny — Phases 1–3 alone deliver substantial debugger value.

---

## Files this plan will touch

**Backend:**
- `src/recipeOrchestration.ts` (`fireYamlRecipe` — wire hooks)
- `src/recipes/chainedRunner.ts` (`registry.set` site — capture snapshots)
- `src/recipes/outputRegistry.ts` (snapshot helper)
- `src/runLog.ts` (`RunStepResult` type extension)
- `src/server.ts` (new endpoints near `:2194`)
- `src/activityLog.ts` (new event kinds — minor)

**Dashboard:**
- `dashboard/src/app/runs/[seq]/page.tsx` (replace polling, add hover, add replay buttons)
- `dashboard/src/components/HoverPanel.tsx` (new)
- `dashboard/src/hooks/useBridgeStream.ts` (reuse — no changes)
- `dashboard/src/app/api/bridge/runs/[seq]/replay/route.ts` (new — POST proxy)

**Tests:**
- `src/__tests__/recipeOrchestration.test.ts` (live-tail wiring)
- `src/runLog.test.ts` (per-step capture)
- `src/__tests__/recipeReplay.test.ts` (new file for Phase 4)
- `dashboard/src/app/runs/[seq]/__tests__/page.test.tsx` (live-tail + hover + replay UI)

---

## What's explicitly out of scope

- **Recording / replay against external SaaS state** — replay is recipe-state replay, not "rewind the world". Slack messages already sent stay sent.
- **Time-travel debugging across multiple runs** — replay starts from the captured state of the original run only.
- **Visual recipe editor / step-by-step debugging** — that's a different product surface.
- **Distributed / remote replay** — replays run in the same bridge process the user is connected to.
