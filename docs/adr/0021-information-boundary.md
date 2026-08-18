# ADR-0021: The Information Boundary — What May a Model Know?

**Status:** Accepted — Phases 1 and 2 implemented 2026-08-14; Phase 3 partial
**Date:** 2026-08-12

> **Implementation note, 2026-08-14.** The decision point exists at
> `executeAgent` (`src/recipes/agentExecutor.ts`), evaluated before dispatch,
> with the pure decision in `src/privacy/dataPolicy.ts`. What is and is not
> built, stated exactly:
>
> - **Phase 1 (declared labels)** — built. `parseDataPolicy` reads a step's
>   `data_policy`; absent means `internal` and behaves as before, so existing
>   recipes are unaffected. An UNRECOGNISED classification is refused rather
>   than defaulted: silently reading a typo as `internal` would leave an
>   operator believing they had labelled something when they had not.
> - **Phase 2 (the decision)** — built, all five values, pure and model-free.
>   `narrowest()` enforces the never-widen rule.
> - **Phase 3 (receipts)** — built. `src/privacy/boundaryReceiptLog.ts`
>   persists to `boundary_receipts.jsonl` alongside the gate's decision
>   record, same shape and same directory mode. It has NO FIELD FOR THE
>   PAYLOAD, by construction: a privacy audit log containing the prompts
>   would be the largest unclassified copy of exactly the material the
>   boundary protects. Only declared metadata is stored — classification,
>   category names, destination, decision, reason. Enforcement deliberately does NOT depend on the sink being
>   configured — a boundary that refuses only when its audit trail happens to
>   be wired could be disabled by removing the sink.
> - **`ALLOW_REDACTED` REFUSES.** Redaction is not implemented, so a step that
>   must have a category removed is refused rather than sent unredacted.
>   "We know something must be removed and cannot remove it" has to fail
>   closed; the alternative sends the data and records that it should not have.
> - **Wiring.** `buildAgentExecutorDeps` (`src/recipes/yamlRunner.ts`)
>   supplies both `loadPrivacyConfigFn` and `recordBoundaryDecisionFn`.
>   Until it did, the boundary was correct, tested and INERT in
>   production: optional deps that no caller supplies are
>   indistinguishable at runtime from a feature that was never built.
>   A source-level test asserts the wiring is present, because the
>   regression it guards is a line going missing.
> - **Shadow mode (`patchwork privacy shadow`)** — built 2026-08-18.
>   Observes what a CANDIDATE policy would have done without enforcing it.
>   Three things about it are load-bearing:
>
>   - It reads `privacy.shadow`, a SEPARATE key from `privacy.destinations`.
>     One key would mean switching shadow on switches enforcement on, so an
>     operator asking "what would this policy do?" would find out by having it
>     applied to live traffic.
>   - It observes LIVE at the decision point; it does not replay. `workers
>     shadow` and the Butler grader both replay `runs.jsonl`, and copying them
>     was the obvious move and does not work: a run-log `agent` step records
>     no `data_policy`, no driver and no destination, so a replay tool would
>     have to invent its inputs. A privacy report built on invented inputs is
>     worse than none, because it reads as measurement.
>   - It reports the DENOMINATOR first and refuses to print a bare crossing
>     count. `agent` steps were ~3% of logged step volume when this was built
>     (54 of 1,795), and orchestrator dispatch is not observed at all — so "N
>     crossings" alone invites "my policy is fine" from a partial surface. An
>     empty ledger reports "nothing observed", never "0 crossings".
>
>   It lives INSIDE the enforcement chokepoint, so the guarantee that matters
>   is that it cannot perturb enforcement: the observer returns void and
>   swallows everything, and a test asserts dispatch is identical with and
>   without a shadow policy that would DENY. That test is paired with an
>   assertion that the shadow actually disagreed, or it would pass for the
>   wrong reason.
> - **Not built, unchanged from below:** detection, purpose-based
>   minimisation, least-data routing, policy packs. Destinations are supplied
>   by config (`privacy.destinations`) since 2026-08-14 — see
>   `src/privacy/destinationRegistry.ts`. `executeAgent` resolves its own
>   destination rather than requiring each of the four dispatch sites to
>   pass one, because a boundary that depends on every call site
>   remembering has one bypass per call site. With no `privacy` block the
>   boundary stays inert; registering a destination is how an operator
>   OPTS IN. Once opted in it fails CLOSED — an unrecognised driver
>   resolves to the strictest registered remote, never to "no
>   destination".
**Bounded by:** [ADR-0019](0019-open-core-boundary.md) — the engine is MIT and
lives here; organisation-wide policy is control-plane. See "Open-core boundary".
**Related:** [ADR-0016](0016-approval-hook-fail-closed.md) (fail-closed gating),
[ADR-0017](0017-decision-record-actor-and-forbid.md) (decision records).

## Context

The autonomy gate answers *what may this worker do?* Nothing answers *what may
this model be told?*

Reading `/patients/jane.pdf` is not, by itself, a problem. Sending its contents
to a hosted model is an information-boundary decision, and today the runtime
makes that decision implicitly — whatever the step declares, or whatever driver
the bridge was started with.

**There is no existing chokepoint for this, and an earlier reading of mine that
said otherwise was wrong.** `costRouter` looked like the seam because it selects
a `(driver, model)` pair. It is not: it short-circuits twice —

```ts
if (!downshift || downshift.length === 0) return preferred;
const remainingUsd = budget.remainingUsd();
if (remainingUsd === undefined) return preferred; // no USD cap → no routing
```

— so a step with no downshift list and no USD cap never passes through any
decision function at all. Cost routing is an *opt-in re-selection*, not a gate.
Binding privacy to it would have produced a boundary that silently covers only
budgeted steps: enforcement that looks total and is partial, which is worse than
none because it is believed.

The real boundary already exists, unconditionally, and is already fail-closed:
**`executeAgent`** (`src/recipes/agentExecutor.ts`). Every agent step in both
runners dispatches through it, it resolves the driver, and it already refuses to
run rather than run un-gated:

> refusing to run un-sandboxed

That refusal is the precedent this ADR extends. The question changes from *can
this worker's tools be constrained?* to *may this destination receive this
context at all?*

## Decision

**Introduce an information-boundary decision point at `executeAgent`, evaluated
before dispatch, with declared labels only. No detection in this ADR.**

### The invariant

> No **recipe agent-step** context leaves Patchwork without passing the
> information-boundary decision point.

The qualifier is load-bearing and was added after the fact — see
[Scope: what the boundary does NOT cover](#scope-what-the-boundary-does-not-cover)
below. As originally written this said "no model-bound context", which claimed
coverage the code does not provide.

And, mirroring the never-widen rule the autonomy gate already relies on:

> A downstream decision may further restrict or reduce context. It may never
> restore information an upstream policy removed, nor widen a destination an
> upstream policy refused.

### Precedence

```
privacy  →  capability  →  cost
```

In that order, and not negotiable by the later stages. A cheaper or more capable
model that is not authorised for the data does not become authorised by being
cheaper or more capable. Concretely: the privacy decision filters the candidate
set, and `costRouter` chooses only within what survives.

### Phase 1 — declared labels

Steps declare what they carry; destinations declare what they may receive.
Nothing is inferred.

```yaml
- agent:
    prompt: …
    data_policy:
      classification: confidential
      categories: [financial]
```

```yaml
destinations:
  local-qwen:
    type: local
    classifications: [public, internal, personal, confidential, restricted]
  cloud-primary:
    type: remote
    classifications: [public, internal]
```

Absent policy means `internal` and behaves exactly as today, so existing recipes
are unaffected. This is the same fail-soft choice `members.json` makes and for
the same reason: a boundary that breaks every existing install to solve a
problem those installs do not have will be turned off.

### Phase 2 — the decision

`ALLOW` · `ALLOW_REDACTED` · `LOCAL_ONLY` · `REQUIRE_APPROVAL` · `DENY`

Deterministic, a pure function of (declared classification, destination policy),
and therefore testable without a model in the loop.

### Phase 3 — receipts

Every boundary decision produces a record, in the same shape and store as gate
decisions: what was declared, where it was going, what was removed, what was
retained, why. Patchwork's existing claim is *every consequential decision leaves
a receipt*; this extends it from **what the AI did** to **what the AI was told**.

## Scope: what the boundary does NOT cover

**Orchestrator task dispatch is out of scope (#1397).**

`ClaudeOrchestrator` sends prompts to a model by a different route than
`executeAgent`, and there is **no information-boundary decision on that path**.
A `runClaudeTask` prompt — including one enqueued by an automation hook — reaches
a driver without being judged, and no receipt is written for it.

This is a deliberate narrowing, not an oversight left unstated. The invariant
above originally claimed all model-bound context; the enforcement only ever
covered the recipe agent-step path. **A stated invariant broader than its
enforcement is the part that must not persist**, because it invites exactly the
false confidence receipts exist to prevent: an operator reading the ADR would
conclude orchestrator traffic was governed, and nothing in the system would
contradict them.

Why it is not simply wired up: the boundary answers *may this data go to that
destination*, and an orchestrator task has no declared `data_policy` and no
natural place to put one. It is a free-form prompt, frequently assembled from
workspace context rather than from a recipe step. Wiring the existing decision in
without first answering that would give every orchestrator task the default
classification — a check that runs, always says `internal`, and writes an
affirmative receipt about a label nobody supplied. That is the failure the recipe
path itself had before the destination registry existed, reintroduced one layer
over.

Bringing it in scope requires, first, a declared-policy channel: a per-task label,
or a workspace-level default that is **recorded honestly as a default rather than
as a declaration**. The receipt shape must then distinguish `declared` from
`assumed`, or it asserts something about operator intent that no operator
expressed.

Until that exists, the honest statement is the one above: this path is
ungoverned, and the ADR says so.

`src/__tests__/boundaryScope.test.ts` pins this to the code. It fails if
orchestrator dispatch gains a boundary decision — at which point this section is
wrong and must be updated with it — and it fails equally if the recipe path ever
loses one, so it cannot pass by both sides being empty.

## Explicitly not in this ADR

**Detection.** No regex PII scanning, no classifier. Detectors may later *suggest*
a classification; policy decides. A detector that is itself the security boundary
fails silently on everything it does not recognise, and its recall is unknowable.

**Purpose-based minimisation and least-data routing.** The strongest ideas in
this space — send only what the task needs — are also where determinism ends. If
a model decides what the minimum is, the boundary is enforced by the thing it
constrains. Revisit only with declared per-task field allow-lists.

**Policy packs.** See below.

## Not a plugin

Plugins run **in-process with the same Node privileges as the bridge**
(`documents/plugin-authoring.md`: "Do not load untrusted plugins"). That is
acceptable for a connector and unacceptable for the mechanism guaranteeing that
confidential data does not reach a hosted model. The boundary sits beneath
recipes, workers and plugins — not beside them as something they can decline to
call.

## Open-core boundary

Per ADR-0019, and the line is the same one drawn for identity — *whose* policy it
is, not which mechanism:

| Part | Where | Licence |
|---|---|---|
| Labels, destination registry, routing decision, local/cloud enforcement, basic redaction, local receipts | this repo | MIT |
| Organisation policy inheritance, cross-workspace management, retention, signed evidence, approval routing for exceptions, curated industry policy packs | `patchwork-control-plane` | non-MIT |

**The enforcement point should be open, deliberately.** People need to be able to
read the code that decides whether their confidential information leaves the
machine. A closed lock is not more trustworthy for being closed.

One caution recorded because it will come up: curated industry policy packs are
*regulatory content*, not software. They carry liability software does not — if a
pack is wrong, the customer's position is that they bought our rules — and they
need maintenance as regulation moves. The defensible commercial asset is
cross-client policy management and attested evidence, which cannot exist without
a control plane at all.

## Consequences

**A new refusal path.** A recipe declaring `restricted` with only remote
destinations configured will halt. That is the feature, and it will look like a
regression the first time it fires.

**The precedent is thinner than it appears.** It is tempting to say Patchwork
already redacts secrets before prompting. It does not: `redactSensitive` /
`captureForRunlog` govern *persistence and display*, and until #1349 they missed
the snake_case `api_key` that recipe YAML actually uses. Prompt-bound redaction
is new work, not an extension of something proven.

**Sequencing.** This is a third gate. The second one spent 2026-08-11 being shown
to have silently mis-recorded its own evidence three separate ways (#1340, #1341,
#1343). A privacy receipt is a compliance assertion — "we did not send this" —
and is the worst possible place to discover a fourth silent-loss path. Do not
start Phase 3 until trust accrual has been observed end to end on real evidence.

**Shadow mode early, not late.** — BUILT 2026-08-18, and the "reusing that
pattern" part of this paragraph was wrong. `workers shadow` and `workers
backtest` replay `runs.jsonl` because their inputs are in it; the boundary's
inputs (classification, resolved driver, destination) are never persisted, so
there is nothing to replay. Shadow observes live at the decision point instead.
The conclusion survives: it is the only part of this design that produces
evidence a customer can act on before they have adopted anything.

## Alternatives rejected

**Bind privacy to `costRouter`.** Rejected on the evidence above: it is opt-in,
so the boundary would cover only steps that happen to have a budget and a
downshift list. Partial enforcement that presents as total.

**A privacy plugin.** Rejected: plugins are in-process with bridge privileges and
optional by construction. "Hopefully everyone uses it" is not a boundary.

**Detection first.** The tempting start, and the reason such systems end up
unfalsifiable. Labels first make the policy engine testable; detectors can be
added behind it once there is something to test them against.

**Classify data alone, ignoring destination and purpose.** A phone number is not
inherently forbidden — it is necessary for "send an appointment reminder" and
unnecessary for "summarise sales performance". The decision is
(data × destination × purpose), and this ADR ships the first two. Purpose is
declared future work, not inferred.
