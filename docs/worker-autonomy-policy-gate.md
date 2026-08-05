# Worker Autonomy — the Policy Gate (keystone)

**Status:** implementation complete · last updated 2026-06-30
**Shipped:** compensable-at-L2 gate (#1036), contextRisk seam + AutonomyDecisionOpts keystone (#1040), cold-start priors (#1037), shadow machinery (#1025), trust-dial dashboard (#1026), live gate (FLAG_WORKER_AUTONOMY, #1027), durable-outcome labels (#1042), agent-step sandbox (#1039).
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
| Cold-start latency | **prior pseudo-count** (reduces novel-floor latency) | instant | **SHIPPED — #1037**; **backtest-as-divergence** (calibrate from history) is the follow-on |
| Sparse high-blast samples | **compositional trust** (policy over earned sub-claims) | — | no |
| Non-stationarity | **regime_freshness** (time-decay + discontinuity markers) | medium | partial — `minEvidenceAtLastPromotion` (#1039) is a special case |
| Wrong unit of trust | **context_risk** (live situational de-rater) | fast, day-1 | **SHIPPED — #1040** |

> **Shadow machinery**: **SHIPPED — #1025**. `shadowObserver` + `shadowReport` + `runWorkerShadow` all live. `patchwork workers shadow` is the primary observability tool.

> **Action-class domain taxonomy**: the `vcs-remote` domain **no longer exists** (split into `vcs-push` for `gitPush` and `vcs-merge` for `githubMergePR` in #1038). Trust earned on PR creation cannot unlock push/merge — domains must not span operations with materially different blast radius or reversibility. `linear.list_issues` and `sentry.get_issue` moved from compensable to `issue-read` (reversible) in #1038. Read operations belong in reversible domains regardless of which tool they use.

> **autonomyCeiling=1 safety callout**: ceiling=1 blocks compensable actions even at earned L4 (ceiling caps `effectiveLevel` before the L2 check). One worker in ceiling-1 mode will never autonomously push, merge, or file issues regardless of earned trust.

> **Shadow observer correctness**: (1) `ingestDecision` silently drops `DecisionRecord` without `recipeName` — general `approvalGate` MCP approvals from Claude Code sessions are excluded from ramp comparison (#1034); (2) `ingestRun` skips steps whose `haltReason` categorizes as `approval_rejected` — human-rejected/expired/cancelled approvals do not poison the Beta posterior (#1028); (3) `owned` field on `WorkerShadowReport` board rows — not-owned rows flagged `⚠ NOT OWNED — gate floors to L0` (#1028).

> **Worker evidence filtering**: `readRuns()` queries filtered by worker recipe names (not global last-100 window) so sparse-worker evidence is not aged out by unrelated recipe traffic (#1039). Recipe names are deduped before evidence aggregation to prevent double-counting.

> **Known limitation**: recipe-run step tool IDs (e.g. `git.log_since`, `file.write`) do not yet map to `DOMAIN_BY_TOOL`, which keys on MCP tool names. Steps using recipe-native tool IDs are classified as `domain:other`; autonomy dial attribution is approximate until the taxonomy is extended.

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

**Durable-outcome labels** — **SHIPPED #1042.** `isDurableSuccess(reversibility, runAt, now, windowMs)` pure predicate; `DEFAULT_DURABILITY_WINDOW_MS = 24h`. Reversible successes and all failures count immediately. Compensable/irreversible successes are withheld until they survive the durability window. `now` is injected via opts on `buildShadowReport` / `getWorkerShadowData` / `loadWorkerTrustForRecipe` (production defaults to `Date.now()`). Revert/close detection within the window remains future work.

---

## 2b. Agent-step autonomy sandbox (shipped #1039)

`disallowedToolsForAgentStep()` emits both bare and `mcp__patchwork__`-prefixed forms for known-risky domains. These are merged into the flat + chained agent paths via `mergeAgentDisallowedTools`. Enforcement requires `--driver subprocess` — `agentExecutor` **fails closed** (`enforceSandbox` flag) on any other driver rather than silently skipping the deny list. Unknown tools are NOT blanket-denied (preserves harmless reads).

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

> **Considered-approval KPI** — **LIVE as of #1032**: `GET /approvals/kpi` tracks reject rate, latency percentiles, channel split, and rubber-stamp warnings per worker × action-class. Dashboard: Workers page `ConsideredApprovalPanel`.

> **Explain-this-decision — LIVE**: `patchwork gate explain <workerId> <classKey>` renders the most recent Decision Record row(s) as plain-English prose (no bridge required; also `GET /gate/decisions`). `--diff` (Tier 2, also LIVE) compares the 2 most recent decisions and reports only the fields that changed. Both explain *decisions*, not yet *why trust moved* over time. That needs a genuinely new join between this log and the (currently in-memory-only) trust-level graduation events in `WorkerLevelStore` (Tier 3), deliberately deferred until there's enough Decision Record volume to justify it.

---

## 6. Sibling trust-architecture layers (shipped 2026-07-13)

The gate above governs *how much autonomy a worker has earned*. A separate set of
deterministic, trust-independent layers governs *what's allowed regardless of
autonomy* and *what can be undone/replayed* — these compose with, but are distinct
from, the earned-trust ramp. All shipped 2026-07-13 (#1157-#1163):

- **Deterministic policy** (`src/policy.ts`, `patchwork.policy.yml`) —
  forbiddenPaths/allowedNetworkHosts/allowedCommands/per-worker allowedTools,
  checked BEFORE the trust gate. No amount of earned trust unlocks a
  policy-forbidden action. `FLAG_ENFORCE_POLICY`.
- **Cross-run idempotency** (`src/recipes/idempotencyKey.ts`'s
  `WriteEffectLedger`) — disk-backed dedup so a retried attempt doesn't replay
  write side effects. Predates this wave (PR5b) but is part of the same
  trust-architecture stack.
- **Circuit breakers** (`src/recipes/circuitBreaker.ts`) — per-`(recipe, tool)`
  CLOSED→OPEN→HALF-OPEN state machine so a broken dependency stops getting
  hammered on every cron/webhook trigger. `FLAG_CIRCUIT_BREAKER`.
- **Ephemeral rollback** (`src/recipes/fileRollback.ts`,
  `patchwork recipe rollback`) — undo a recipe attempt's `file.write`/
  `file.append` side effects using a captured pre-image ledger.
- **Flight recorder / mocked replay** (`src/recipes/replayRun.ts`) — per-step
  output capture + replay against captured evidence, for both chained AND flat
  (manual/cron/webhook) recipes, with zero external calls or write side effects.

A 4-dimension multi-agent adversarial review of all five (#1163) found and fixed
17 real defects, including two security regressions introduced in the same
wave (policy checks silently skipped for non-worker recipes; secret redaction
was a no-op on the new flight-recorder capture path) — worth a review pass
after a fast sequence of feature PRs even when each shipped green.

**Deliberately deferred, not forgotten:**
- **Durable SQLite state store** — `documents/roadmap.md` explicitly defers
  this until query volume demands it; the current per-log JSONL model
  (`runs.jsonl`, worker trust store, Decision Record, effect ledger) is a
  deliberate choice.
- **Context distillation / resource ring-fencing** — scoped but not started.
  `src/drivers/local/index.ts` (Ollama/LM Studio) has zero context-window
  awareness today; the lowest-risk starting point if this is ever picked up
  is a preflight prompt-size guard scoped to the local driver only, not a
  cross-driver context-window table or an LLM-summarization step.

---

## 7. The third terminal state — `forbid` (shipped 2026-08-03, ADR-0017)

The gate had two outcomes: `allow` and `gate`. Both are escapable — `gate`
by earning trust, or by a human clicking Approve. There was no way to say
**never**.

`forbid` is that third state. It means no level of earned trust and no human
approval unlocks the action: it holds at L4 with an autonomy ceiling of 4, and
it holds against an operator who approves it.

### Why it is not an empty `reachableLevels()`

The obvious implementation — have `reachableLevels()` return `[]` for a
forbidden class — was rejected. It survives mechanically (`graduation.ts` guards
`nextRung !== undefined`), but it encodes a hard policy as an emergent property
of an empty array, and `[]` vs `[0]` is a distinction that will not survive
maintenance. More importantly it conflates two different things:
`reachableLevels` describes which rungs a class can *climb*, while `forbid` is
an assertion about the *action*. They come apart exactly where it matters.

So `forbid` is a policy predicate — `isForbidden(actionClass, rules)` in
`src/workers/forbidPolicy.ts` — consulted before the trust maths.

### Evaluation order, and the cost of getting it right

`decideWorkerAction` settles forbid **first**: ahead of the agent-step
carve-out, ahead of the reversibility short-circuit, ahead of every level
comparison. Any branch that runs earlier is a path around it.

That ordering means a broad rule (`match: "other"`, say) **can stall every
worker on its agent step**. This is deliberate. That failure is loud and names
the rule that fired; the alternative — letting a carve-out win — fails silently
by permitting an action the operator declared must never happen. A safety
control a carve-out can bypass is not one.

### Rules

Matching mirrors `WorkerManifest.owns`: a domain, an exact class key, or a
prefix. Every rule carries a required `reason`, because a refusal without one
is unusable in a receipt.

Empty or absent rules forbid nothing, so an unconfigured workspace is
byte-identical to the pre-forbid gate. Forbidding is entirely opt-in.

**A deny-list fails in the opposite direction to a roster.** `identity/roster.ts`
degrades a malformed `members.json` to a single implicit owner, because the safe
default for *who you are* is the status quo ante. Silently dropping a malformed
*forbid* rule fails **open** — the banned action becomes merely gated, and a
human can then approve it. So `parseForbidRules` returns the positions it could
not parse, and the caller is expected to shout rather than proceed quietly.

### Compatibility

`GATE_POLICY_VERSION` moved `worker-ramp-v0` → `worker-ramp-v1` with this
change, which earns the bump on both counts ADR-0017 identifies: an enum
widening (breaks exhaustive switches in older readers) and a genuine policy
change. The optional `actor` field shipped *unversioned* by contrast, because a
new optional field is genuinely additive.

### Magnitude bands (`worker-ramp-v2`)

An action class was originally keyed `domain:reversibility:blastTier` — every
component derived from the tool **name**. That made blast tier a property of the
*kind* of action and never of the *instance*, so a trivial charge and a
catastrophic one shared one trust cell: evidence ground out on the former
silently authorised the latter. `outcomeWeight` did not compensate, because it
weights failures by the same static per-class tier.

Value-bearing domains (currently just `payments`) now append a coarse magnitude
band: `payments:irreversible:high:band<=50`. Bands, never raw amounts — an
unbounded key space would give every purchase its own class and none would ever
accumulate enough evidence to graduate. An amount that cannot be read bands as
the **widest** bucket, never the cheapest, so a malformed or adversarial param
cannot be the route to the low-friction class.

Pre-v2 state keyed on the unbanded form is deliberately **not migrated**. It is
left unreachable, and such a class re-earns from the prior. Mapping it onto a
band would launder exactly the trust the band exists to separate: the evidence
in that cell was gathered without regard to magnitude, so it cannot honestly be
claimed for any particular band.

Note this is a guard rail placed *before* the capability: no payments tool is
registered in the recipe tool registry today. The connector methods exist
(`src/connectors/paystack.ts`, `stripe.ts`) but are unreachable from recipes,
and that unreachability is currently the only thing containing them.

Readers were hardened first, in a separate change: `describeGateAction` names an
unrecognised action instead of reporting it as "GATED (asked for approval)", and
`gateOutcomeFor` maps an unknown action to **refuse**, so no build ever offers a
value it does not understand to a human for approval.

---

## 8. The control boundary — asking the gate prospectively (shipped 2026-08-03)

`forbid` gave the gate a third answer. This is the screen that shows all three
before anything is attempted.

The gate is retrospective by construction: a call arrives, and it allows, gates
or forbids. That is right for enforcement and wrong for showing somebody the
boundary, which has to be answerable in advance.

`previewActions` (`src/workers/previewActions.ts`) asks the same question ahead
of time for a set of candidates and buckets the answers into three columns.

### The property that makes it worth having

It calls `decideWorkerAction` and routes through `gateOutcomeFor` — the exact
code enforcement uses. `boundaryForRecipe` extends that a level up, resolving
the worker and trust store via `loadWorkerTrustForRecipe`, the same resolution
the live gate performs.

Both are the same argument. **A preview with its own logic is worse than no
preview.** It drifts, and it drifts silently in the permissive direction: a
screen reading "not permitted" while the gate would in fact allow the action
tells an operator they are protected when they are not. Trust in this screen is
the product claim, so every layer of it has to be a *view of* the gate rather
than a *description of* it. The final test in `previewActions.test.ts` asserts
that agreement directly, for every candidate under several rule configurations.

### Candidates

`defaultCandidatesFor(worker)` derives the default set from the worker's `owns`,
because a worker's ownership is its declaration of purpose. Deliberately not the
whole tool registry: that buries the handful of actions that matter under rows
the worker will never touch, and lands all of them in "needs approval" — a
screen that is technically true and tells an operator nothing.

A caller with a specific set in mind supplies its own. The generic derivation is
in-repo; anything scenario-specific comes from outside it.

### Inertness

Previewing writes nothing. No approval is enqueued — opening a screen must not
spam a human with requests nobody made — and no decision record is written,
because a hypothetical is not a decision and recording one would pollute the
audit trail with things that never happened. Both are pinned by tests.

### Not-enforced is reported, not hidden

When the `worker.autonomy` flag is off, the boundary is still a correct
statement of policy but nothing enforces it. `boundaryForRecipe` returns
`enforced: false` rather than refusing to answer: an operator asking what a
worker may do should get the answer *and* be told it is not live. Hiding it
leaves them with nothing, which is worse.

---

## See also

- [docs/runbooks/worker-autonomy-dogfood.md](runbooks/worker-autonomy-dogfood.md) — operator runbook for the live dogfood campaign
- `src/workers/` — implementation
- `src/policy.ts`, `src/recipes/circuitBreaker.ts`, `src/recipes/fileRollback.ts`, `src/recipes/replayRun.ts` — sibling trust-architecture layers (§6)
- `templates/workers/` — three reference worker manifests
