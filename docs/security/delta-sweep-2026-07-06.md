# Security Delta Sweep — 2026-07-06 (Track A2)

**Scope:** code changed since the 2026-06-19 full audit (`git log --since=2026-06-19`
— ~132 backend files under `src/`, ~77 dashboard files), not a full re-audit.
Three targeted checks, informed by [docs/security/register.md](register.md):

1. Workers subsystem — can a recipe step self-attest trust (poison the
   outcome log / gate-decision log that drives the autonomy ramp)?
2. New HTTP routes (`gate/decisions`, `outcomes`, `recipes/doctor`) — auth.
3. Dashboard proxies + copilot surface — auth consistency, copilot
   propose-vs-execute boundary.

## Finding: `outcomes.classify_issues` can self-attest trust (MEDIUM→HIGH, real, open)

**File:** `src/recipes/tools/outcomes.ts`

The HTTP route `POST /outcomes` (`src/recipeRoutes.ts:1165-1241`) is correctly
hardened: it sits behind the bearer-auth gate, and explicitly rejects
`disposition: "unknown"` with a comment documenting the "SELF-CONFIRM
PROHIBITION" — a worker cannot use this route to confirm its own filing.

Its sibling, the recipe-callable tool `outcomes.classify_issues`, reaches the
exact same `OutcomeStore` (`src/workers/outcomeStore.ts`) but does **not**
inherit that discipline:

- The `issues` param is a caller-supplied JSON string (`outcomes.ts:40-43`),
  parsed and fed straight into the pure classifier `classifyIssueDisposition()`
  with no re-fetch or verification against actual GitHub state. Any recipe
  step — including an LLM agent step earlier in the same recipe — can
  fabricate `{"url": "...", "state": "closed", "stateReason": "completed"}`
  for any issue URL (including one the worker itself filed) and the tool will
  write `disposition: "confirmed"` to `outcome-log.jsonl` for it.
- That confirmed disposition directly feeds `WorkerShadowObserver.ingestRun`'s
  trust-replay — i.e. it moves the worker's trust dial.
- `riskDefault: "medium"` (`outcomes.ts:66`) means it runs fully autonomously
  under the default `approvalGate: "off"` posture, and even under
  `approvalGate: "high"` it still isn't gated (only `"all"` mode gates
  medium-risk tools).
- The `recipeName` param used to attribute the record is also caller-supplied
  and unverified — a recipe can stamp any `recipeName` it likes on a record,
  not just its own.

**Verified clean, for contrast:** `worker_gate_decisions.jsonl` (the Decision
Record) has no recipe-writable path at all — `.record()` is only called from
the bridge's internal gate-evaluation path in `src/bridge.ts`, never from a
tool or route. The self-confirm prohibition is real and effective for that
store; it's specifically the outcome-log tool that has the gap.

**Recommended fix (not yet implemented):**
1. Bump `riskDefault` from `"medium"` to `"high"` — a 1-line change that puts
   this tool under the same gating tier as other trust-ledger-mutating
   actions, so `approvalGate: "high"` (a reasonable production posture) now
   queues it for human confirmation. Does not help under the default
   `approvalGate: "off"`, but it's the smallest change matching an existing
   convention.
2. Structural fix (bigger, not done here): verify the tool is only reachable
   from the specific `outcome-ingester` recipe context server-side (not a
   caller-supplied field), and/or have the tool re-fetch issue state from the
   GitHub connector itself rather than trusting the passed JSON verbatim.

## Clean: new HTTP routes — all behind bearer auth

`GET /gate/decisions`, `GET/POST /outcomes` + `/outcomes/pending`, and
`GET /recipes/doctor` are all registered inside the same route-dispatch path
that runs after the bearer-auth gate in `src/server.ts:872-889`. No route
bypasses auth. `POST /outcomes` additionally has the explicit self-confirm
prohibition described above.

## Clean: dashboard proxies + copilot surface

- **Copilot** (`dashboard/src/app/api/bridge/copilot/message/route.ts`) never
  executes an action — it only forwards to the bridge and returns
  `{reply, action?}` verbatim. The confirm-side handler
  (`dashboard/src/app/page.tsx`) routes every action type through the same
  shared, already-gated hooks used elsewhere (`useRunRecipe`,
  `useToggleRecipeEnabled`) — no raw fetch bypass. The route itself is not in
  `middleware.ts`'s exemption list, so it's session-gated like everything else,
  plus a `requireSameOrigin` CSRF check on top.
- **New dashboard pages** (`decisions`, `insights`, `insights/replay`,
  `sessions`, `sessions/[id]`, `workers`, `recipes/compare`, `recipes/new`)
  have no dedicated proxy routes of their own — they all consume the single
  shared, session-gated `[...path]` catch-all proxy. No manual
  auth-reimplementation found (the historical PAD=256 bug class doesn't
  recur here).
- **Kill-switch confirm dialog + `relay/halt`** — the dialog is pure
  presentational UI with no auth logic; `relay/halt/route.ts` reuses the same
  already-hardened `verifyBearerToken`/`constantTimeEqual` helper `relay/push`
  uses (the fixed helper from the register's HIGH section), not a fresh
  reimplementation.
- **Login route** — both previously-fixed defects (M4 missing-password
  global-failure recording, PAD=256→1024-byte truncation fix) are confirmed
  still present and correct; no regression.

## Summary

| Check | Result |
|---|---|
| Workers subsystem — outcome-log self-attestation | **REAL FINDING, open** — `outcomes.classify_issues` |
| Workers subsystem — gate-decision-log self-attestation | Clean — no recipe-writable path |
| New HTTP routes auth | Clean |
| Dashboard proxy auth consistency | Clean |
| Copilot propose-vs-execute boundary | Clean |
| Kill-switch / relay-halt auth reuse | Clean |
| Login route regression check | Clean |
