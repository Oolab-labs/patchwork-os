# ADR-0021: The Information Boundary — What May a Model Know?

**Status:** Proposed
**Date:** 2026-08-12
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

> No model-bound context leaves Patchwork without passing the information-boundary
> decision point.

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

**Shadow mode early, not late.** `workers shadow` and `workers backtest` already
implement replay-without-enforcing. A privacy shadow mode reusing that pattern is
cheap, and it is the only part of this design that produces evidence a customer
can act on before they have adopted anything.

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
