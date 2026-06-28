# Worker Ramp v0 — design

**Status:** v0 implementation (shadow-mode). Net-new subsystem under `src/workers/`.

## Thesis

A **worker** is a persistent, responsibility-based role (Release, Dependency-upkeep,
Test-guardian…), not a session or a prompt. Its durable asset is its **track record**,
which model swaps don't touch. The product spine is the **trust/autonomy ramp**:
how much a worker may do unsupervised, earned by evidence, scoped narrowly.

## Non-negotiable design decisions (and why)

1. **Worker = recipe + identity, NOT a new first-class actor object.** Patchwork's
   recurring failure mode is forking the execution model (flat vs chained runner
   drift; "incomplete-fix-one-path"). A parallel `Worker` runtime would re-introduce
   exactly that. The recipe is the worker's *body* (triggers + steps); the worker
   manifest adds *identity + owned action-classes + trust priors* as additive
   metadata. The recipe schema is **untouched**.

2. **Trust is per `(worker × action-class)`, never global.** A worker with 2,000
   clean dependency bumps has earned *nothing* on "production deploy". Novel classes
   default to the floor regardless of overall reputation. This single rule defeats the
   scariest failure: a trusted worker doing something unprecedented.

3. **The level is a Bayesian posterior, surfaced as discrete L0–L4.** Internals are a
   Beta posterior over per-class reliability; the discrete level is a threshold
   crossing of its *lower confidence bound*. This makes three hard problems fall out
   of one mechanism:
   - **Asymmetry** ("slow up, instant down") is information, not a hand-tuned rule: a
     high-blast failure is high-information (large posterior shift), routine successes
     are low-information.
   - **Cold-start + marketplace portability** unify: a shipped worker arrives with a
     *prior* (competence) and wide uncertainty; local evidence tightens it (trust). A
     vendor can ship a prior mean but cannot ship your posterior — uncertainty only
     collapses on *your* data.
   - **Evidence sparsity is survivable**: priors carry the worker through the weeks
     before it has local evidence.

4. **Reversibility is the primary taxonomy axis, not risk-tier.** A ramp rung is an
   *execution mode*, and the middle rungs (act-with-undo / act-and-sample) only exist
   where a compensating action exists. An action-class is
   `(domain × reversibility × blastTier)`; reversibility ∈
   `{reversible | compensable | irreversible}`. Irreversible classes skip the safety
   rungs, so their bar to autonomy must be far higher.

## The ramp

| Rung | Execution mode | v0 status |
|---|---|---|
| L0 suggest | propose, don't execute | deferred (phase 2) |
| L1 approve-each | queue for human OK | **v0** (= today's gate `queue`) |
| L2 act-with-undo | execute in a reversible window | deferred (needs compensating-action infra; reversible classes only) |
| L3 act-and-sample | execute + async sampled review | deferred (needs async review queue) |
| L4 autonomous | execute, escalate anomalies only | **v0** (= today's gate `bypass`) |

**v0 surfaces only L1↔L4** — the two execution modes that already exist in the
approval gate (`evaluateInProcessGate` → queue/bypass). The full L0–L4 posterior is
computed for the dial; only the L1/L4 distinction is *actionable* in v0. L0/L2/L3 are
phase 2 (new execution machinery).

## v0 scope

**Built (this PR):**
- `actionClass.ts` — classify a tool call into an action-class + blast weight.
- `trustLevel.ts` — Beta posterior, LCB, posterior→level mapping.
- `graduation.ts` — fold outcomes into the posterior with asymmetry, hysteresis
  (dwell + demote-cooldown), and novel-class floor.
- `workerLevelStore.ts` — JSONL persistence of posteriors + a promotion/demotion
  event log (the compliance/audit artifact).
- `worker.ts` — parse a worker manifest; resolve which action-classes it owns.
- `shadowGate.ts` — a **pure** recommender: what the ramp *would* decide. Logged in
  shadow; **does not change live gate behavior** in v0.
- `templates/workers/*.worker.yaml` — 3 dogfood workers for developing Patchwork.
- `shadowRun.ts` — replay an outcome sequence → dial trajectory (the evidence-latency
  test).

**Phase 2 — live gate flip (built, flag-gated, default OFF):**
- `workerGate.ts` — the **live** decision `decideWorkerAction(worker, tool, params, store)`.
  Reversibility-scoped: REVERSIBLE actions flow un-gated regardless of earned
  level (undoable — the routine work a new worker should just do; blast still
  drives the failure weight); COMPENSABLE / IRREVERSIBLE actions are gated for
  approval until the worker has EARNED (ceiling-capped) L4 on that exact class.
  This is the answer to "what should an unearned AUTOMATED worker action do":
  fail-closed *only for the dangerous, non-undoable actions* — pure "gate
  everything unearned" would halt a new worker on everything for weeks (the
  evidence-latency reality), which is unusable. **Agent (reasoning) steps are
  never gated by the ramp** (they classify as `other:irreversible`, owned by no
  one — gating them would stall every worker; the downstream tool steps still
  gate on their own class).
- `runWorkerShadow.loadWorkerTrustForRecipe(name)` — resolves the owning worker +
  its earned-level store, **replayed in ascending timestamp order** (same as the
  dial; the graduation dwell logic is order-sensitive — newest-first would mean
  no risky class ever graduates and earned-L4 would be unreachable).
- `recipeOrchestration.buildWorkerAutonomyGate(name, tierFn)` — when the
  **`worker.autonomy`** flag is on AND a worker owns the recipe, composes the
  worker-aware fn as a **FLOOR over the tier fn** (a worker `allow` decision
  DEFERS to the tier fn, so it can only ADD gating — never drop the operator's
  `approvalGate` protection, even on manual runs) and sets `gateAutomatedRuns` so
  the flat runner's gate engages on AUTOMATED triggers too (that's how workers
  run). Flag off OR no owning worker → byte-identical to pre-flip behaviour.
- Fail-soft: any error resolving worker trust falls back to the tier gate; the
  decision never *widens* access — a "gate" result only routes to the existing
  human-approval queue (fail-closed on reject/expire/cancel).

**Still deferred (phase 3+), deliberately:**
- L0/L2/L3 execution modes (suggest / reversible-window via `beginTransaction`/
  `rollback` / async-sample) — phase 2 only distinguishes gate vs flow.
- Per-step caching of the replayed trust store (replays the run log per run).
- Multi-worker coordination / delegation protocols (YAGNI until ≥2 mature workers).
- License-tier autonomy caps; marketplace prior shipping.

**Done in earlier phases:** shadow logger + the trust-dial UI (dashboard board).

## How it composes from what exists

| Need | Reuse | Net-new |
|---|---|---|
| self-waking role | recipe triggers (cron/file-watch/git/on-test-run) | worker identity layer |
| blast tier | `classifyTool` (low/med/high) | reversibility tag |
| content risk | `RiskSignal` kinds (`destructive_command`, `data_exfiltration`, …) | — |
| evidence | decision/run/approval/judge trace stores | regroup by `(worker × class)` |
| control floor | approval gate (`requireApprovalFn` / `evaluateInProcessGate`) + kill switch | worker-aware decision (live, `worker.autonomy` flag) |
| experience compounds | what compounds is the **earned autonomy state**, not model memory — delivered before a distillation loop exists | — |

## Anti-gaming (honest)

- **Trust-transfer grinding** (1,000 trivial actions → one catastrophe): defeated by
  per-class scoping + **blast-radius weighting** — a routine success barely moves the
  posterior; a high-blast failure dominates. Count alone never graduates a risky class.
- **Trust-hoarding** (do less to keep stats clean): *not cleanly solvable* from traces
  — there is no ground-truth denominator for "should have acted". v0 mitigation is an
  operator-set per-class expected cadence that **flags** silence (does not auto-demote).
  Documented as a soft signal, not a solved metric.
- **Flapping**: dwell-time before a climb + a demote-cooldown after a fall.
