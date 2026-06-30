# Worker Autonomy — the Policy Gate (keystone)

**Status:** design / sequencing doc · 2026-06-30
**Scope:** `src/workers/` — generalize the autonomy decision from a threshold on
one slow signal into a policy over several signals, most of them fast.

> One-line thesis: **don't make the slow earned-trust posterior carry the whole
> autonomy decision.** Wrap it in fast, computable signals. The posterior is the
> input that compounds into a moat; the other inputs make the product demoable on
> day 1, safe on sparse high-value actions, and robust to drift — and they are the
> things "approve-similar" structurally cannot copy.

This is deliberately framed against the four standing weaknesses of an
earned-trust model (cold-start latency, sparse high-blast samples,
non-stationarity, wrong unit of trust). Each weakness is answered by a *different
input to the same gate*, not a separate subsystem.

---

## 1. Where we are today

The live decision is `decideWorkerAction` (`src/workers/workerGate.ts`):

```ts
decideWorkerAction(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  store: WorkerLevelStore,
): WorkerGateDecision   // { action: "allow" | "gate", effectiveLevel, ... }
```

The decision is essentially:

```
effectiveLevel = min(earnedLevel(worker, class), autonomyCeiling)   // store-derived, SLOW
action         = reversible        ? allow
               : compensable && eff >= L2 ? allow
               : eff >= L4         ? allow
               : gate
```

`earnedLevel` comes from the Beta-posterior LCB ramp (`trustLevel.ts` →
`graduation.ts`). It is the **only** signal. Everything good about the system —
asymmetry, blast-weighting, never-widen — already lives here. The problem is not
the math; it's that one slow input gates everything.

---

## 2. The keystone change

Make the decision a **policy function over signals**:

```
autonomy = f(earned_trust, context_risk, blast_radius, regime_freshness)
```

Concretely, generalize the gate to take a **decision context** instead of just
the store:

```ts
interface AutonomyContext {
  store: WorkerLevelStore;          // earned_trust (slow, the moat)
  contextRisk?: ContextRisk;        // live situational risk (fast, day-1)
  regime?: RegimeState;             // freshness vs. known discontinuities (medium)
  // blast_radius is already on the ActionClass (actionClass.ts) — no new input.
}

decideWorkerAction(
  worker: WorkerManifest,
  toolName: string,
  params: Record<string, unknown> | undefined,
  ctx: AutonomyContext,             // was: store
): WorkerGateDecision
```

**Backward-compatible seam first.** Land the signature change with `ctx = {store}`
and *no behavioural change* — every new field optional, every absent field a
no-op. All four mitigations then become *additions to `ctx`*, each shippable on
its own, each independently testable. This is the single prerequisite; do it
before any signal work.

### Invariant the gate must keep: **never-widen, and now never-widen-UP**

Every new signal may only **lower** autonomy, never raise it. `earned_trust` is
the sole input that can *grant* autonomy; `context_risk` and `regime_freshness`
can only *de-rate* it. Formally:

```
effectiveLevel = min(
  earnedLevel,
  autonomyCeiling,
  contextCeiling(contextRisk),       // descending only
  regimeCeiling(regime),             // descending only
)
```

This is what preserves the entire existing safety story (and the agent-step
sandbox shipped in #1039) while making the decision richer.

---

## 3. The four inputs, mapped to the four weaknesses

| Weakness | Input | Speed | Already shipped? |
|---|---|---|---|
| Cold-start latency | **backtest-as-divergence** (prime the posterior from history) | compute, not wall-clock | partial — shadow machinery exists |
| Sparse high-blast samples | **compositional trust** (policy over earned sub-claims) | — | no |
| Non-stationarity | **regime_freshness** (time-decay + discontinuity markers) | medium | partial — `minEvidenceAtLastPromotion` (#1039) is a special case |
| Wrong unit of trust | **context_risk** (live situational de-rater) | fast, day-1 | no |

### 3a. `context_risk` — the fast second dial (highest leverage, build first)

A live, situational risk score computed per-action from signals the bridge
**already exposes**, gating *down* only:

- `getDiagnostics` — error/warning count in the touched files
- `getCodeCoverage` — coverage of the touched code
- `getGitHotspots` — is this a churn-heavy/fragile file
- diff size / `getGitStatus` — how big is the pending change
- CI status — is the build currently red

```
contextRisk ∈ [0,1]  →  contextCeiling: high risk caps autonomy down
  clean repo, green CI, small diff   → no de-rate (full earned autonomy)
  red CI / huge diff / hotspot file  → cap to "propose-only" even at earned L4
```

Why this is the keystone's best first move:
- **Zero cold-start.** Computable on day 1 — it carries the pilot demo while the
  posterior accrues. ("L1-earned but the repo is clean → one-click propose" vs
  "L4-earned but CI is red and the diff is huge → stop.")
- **Decouples** "is this worker generally reliable" (slow, earned) from "is this
  situation safe right now" (fast, computed) — directly answers Weakness 4
  (failures come from *context*, not the recipe).
- **Uncopyable.** Approve-similar has no situational model; this is the thing it
  structurally cannot do.

### 3b. `regime_freshness` — drift-aware caution

Evidence must **decay**, not just accumulate (today `applyOutcome` only ever adds
to α/β). Two parts:

1. **Time-decay**: recent outcomes weigh more (exponential forgetting toward the
   prior). Handles gradual drift.
2. **Discontinuity markers**: a model-version bump / framework migration / policy
   change emits a regime marker that **widens the confidence interval** (autonomy
   auto-throttles down) until fresh evidence re-confirms it. Versions the actor:
   a model bump = a new actor with a strong *inherited* prior (CI widened),
   **not** a reset, and the receipts stay honest (prior labeled inherited).

This is a *selling point*, not a tax: "our workers automatically get more cautious
after a major change, then re-earn autonomy" is exactly the safety behaviour an
enterprise wants — and approve-similar can't do it. `minEvidenceAtLastPromotion`
(#1039) is already a degenerate case (one kind of regime change: config tightening).

### 3c. `backtest-as-divergence` — cold-start without faking earned trust

Point the existing shadow machinery (`shadowGate.recommend` vs gate decisions) at
the prospect's **historical** run/PR/ticket logs instead of live. By end of week 1
you have hundreds of real samples — compute-latency, not wall-clock.

**The honest framing — read this twice.** Replaying past *merged* PRs scores
*mimicry of decisions humans already made*, a censored sample: you never observe
the counterfactual where the worker diverged and it would have gone wrong. So the
metric is **divergence-from-human, not success-rate**:

> "the worker agreed with your team on 94% of 300 real actions; here are the 6%
> where it diverged and who was right."

That is more compelling than a fake success posterior (the divergences are where
the value and risk live) *and* it avoids quietly becoming the config-trust product
we claim to beat. Backtest primes the prior + demos calibration; it does not, by
itself, grant autonomy.

### 3d. Compositional trust — the only honest answer to sparse high-blast actions

You will never earn high autonomy on a twice-a-quarter prod deploy from frequency
alone. **Don't try — decompose.** A rare composite (`deploy`) is a policy over
*frequent, observable* sub-claims: tests passed · diff in-scope · migration
reversible · canary held. Each sub-claim is a high-volume action-class you *can*
earn trust on. Autonomy on the composite = a guard over component trust + live
checks, **not** a posterior on the composite.

Caveat we must state plainly: the human writes the decomposition, so the
*structure* of trust is config; only the *leaf* reliabilities are earned. That's
fine and honest — and it makes the enterprise-legible product a **library of
action decompositions** (NIST/SOC2-style controls for AI actions), which sells far
better than "Bayesian autonomy." The chained runner's `step` + `step.expect`
primitives are the substrate. (Caveat to NOT pretend: for genuinely
rare+irreversible+high-blast actions the correct product answer is "10 approvals →
1 *considered* approval," never zero — which is already the repo's KPI.)

A precondition for all of the above: **durable-outcome labels.** Today
`good = step.status === "ok"` (absence-of-error) — an optimistic proxy. A PR that
merged isn't a PR that was *good*. Trust must update on **durable** outcomes (not
reverted, survived N days, issue not reopened, deploy not rolled back), which the
bridge can already detect (`enrichCommit`, `getCommitsForIssue`, revert/reopen).
Until the label is durable, every posterior is confidently measuring the wrong
event — this is the honest foundation under all four inputs.

---

## 4. Sequence (leverage ÷ build cost)

1. **Durable-outcome labels** — cheapest, and nothing else is honest without it.
2. **Keystone seam** — `decideWorkerAction(…, ctx)` backward-compatible, no
   behaviour change. Prerequisite for 3–5.
3. **`context_risk` descending dial** — day-1 demoable, repo already exposes the
   signals, preserves never-widen, answers Weakness 4, carries the pilot.
4. **`backtest-as-divergence`** — small build on existing shadow code; answers
   Weakness 1 honestly.
5. **`regime_freshness`** (time-decay + markers) — medium build, outsized
   narrative value. Makes the #1039 window-eviction fix load-bearing (decay needs
   the full history to recompute).
6. **Compositional trust** — the real moat and the honest answer to Weakness 2;
   sequence last, once the seam + 1–5 prove out.

## 5. Positioning (so we build the right thing)

Lead the product with **governance + reach + receipts** — the policy/decomposition
engine, blast-radius ceilings, the immutable audit trail, and cross-tool span —
all demoable on day 1 with no cold-start. Demote earned-trust from headline to
engine, and reframe its claim from "earned autonomy" to **institutional reliability
memory**: a track record that survives across actions and adapts to drift — which a
stateless context-risk score cannot tell, and which is the one thing the posterior
uniquely earns. Ship the Bayes quietly; sell the governance.
