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
>   **This is not merely unbuilt — see the 2026-08-18 amendment.** The decision
>   point receives an already-rendered prompt, so redaction there could only be
>   detection, which this ADR rejects as a boundary. Refusing is the correct
>   behaviour for a boundary positioned after rendering, and the fix is field
>   labels, not effort.
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
> information-boundary decision point — and, once `privacy.orchestrator` is
> configured, no **orchestrator task** does either.

The qualifier is load-bearing and was added after the fact — see
[Scope: what the boundary does NOT cover](#scope-what-the-boundary-does-not-cover)
below. As originally written this said "no model-bound context", which claimed
coverage the code does not provide.

The second clause carries a condition and it is not decoration. Orchestrator
dispatch is enforced only where an operator has classified the channel; on an
install that has not, the path is observed and ungoverned exactly as before.
Stating the clause unconditionally would reintroduce, one path over, the
overbroad-invariant failure this section exists to record.

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

#### Classify by what the step HANDLES, not by what is in its prompt

An author writing a `data_policy` naturally reads the prompt and classifies what
they see there. For a tool-enabled driver (`claude-code`, `subprocess`) that
**under-classifies**, because the prompt is frequently *instructions to go and
fetch the data* rather than the data itself.

```yaml
- id: weekly_summary
  agent:
    driver: claude-code
    prompt: |
      Step 1 — Gather data. Run:
        ls -1t ~/records/*.md | head -7
      For each file, extract the recorded measurements and summarise the week.
```

Read literally, that prompt contains no records at all. Read for what the step
*handles*, it processes a week of them. **The second reading is the correct
one, and it is not the one a careful author necessarily arrives at.** The
abstract rule is easy to agree with and still get wrong, which is why the
example is here rather than only the rule.

So: **classify by everything the step will handle, including whatever its tools
will fetch.** If a human could not read the output without seeing the
underlying records, the step handles those records.

This is not a hole in enforcement, and the obvious inference from the above is
wrong. The boundary gates the **dispatch**, not the payload. A step declared
`personal` against a remote destination resolves to `LOCAL_ONLY`, so the step
runs against a local model and *that* model performs the tool fetch — the data
never leaves. `DENY` stops the step outright. Either way the fetch happens on
the correct side of the line, or does not happen.

The gap is entirely in **how an author picks the label**, and this ADR's design
already anticipates it: classification is *declared, never detected*, precisely
so that it can describe a step's subject matter rather than its bytes. What was
missing was saying so where an author reads.

`recipe lint` emits a hint for the population most likely to be affected — an
agent step with a tool-enabled driver and no `data_policy`. It is a hint and
not an error: absence is a legitimate default, deliberately, and the hint marks
where the default is most likely to be the wrong one. It does not and cannot
find an under-classified step that *did* declare a policy.

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

**SUPERSEDED 2026-08-30 — the precondition was built. See "Orchestrator
enforcement" below.** The section above is kept verbatim rather than rewritten,
because the reasoning it records is the reason the amendment took the shape it
did. What is no longer true is only its final sentence.

**Observed in shadow since 2026-08-18 (#1397), still not enforced.** The
objection above is to asserting a DECLARATION nobody made — it is not an
objection to looking. `claudeOrchestrator` now records each dispatch to the
privacy shadow ledger, stamped `path: "orchestrator-task"` and
`labelSource: "assumed"`, with `enforcing: false`. Nothing refuses, alters or
delays a task; the scope statement above is unchanged.

This is deliberately the cheap half. The design question — per-task label vs
workspace default — was being answered from ZERO measurements of how much
traffic this path actually carries, and the volume should choose it. The
receipt-shape requirement stands: when enforcement does arrive, `declared` and
`assumed` must stay distinguishable, which is why the distinction is being
recorded now rather than retrofitted onto a ledger that already conflated them.

`src/__tests__/boundaryScope.test.ts` pins BOTH sides: no enforcement markers in
`claudeOrchestrator.ts`, AND the observation call present at the dispatch site.
A one-sided check would keep passing if the observation were deleted, and the
report would then show zero orchestrator rows — indistinguishable from a quiet
path, which is exactly what an unobserved one looks like.

`src/__tests__/boundaryScope.test.ts` pins this to the code. It fails if
orchestrator dispatch gains a boundary decision — at which point this section is
wrong and must be updated with it — and it fails equally if the recipe path ever
loses one, so it cannot pass by both sides being empty.

## Amendment 2026-08-18 — redaction and purpose share one prerequisite

Recorded after investigating what it would take to make `ALLOW_REDACTED` stop
meaning refuse. The answer changed the sequencing, so it belongs here rather
than in a commit message.

### `ALLOW_REDACTED` cannot be implemented where the decision is made

`redactCategories` names declared CATEGORIES — `financial`, say. Removing one
means removing the financial content from the prompt. But `executeAgent`
receives `renderedPrompt` (`yamlRunner.ts`): the template has already been
flattened into a single string, and every variable boundary with it.

So at the decision point, "remove the financial parts" can only mean "find the
financial parts in prose" — **detection**. This ADR rejects detection as the
boundary, in its own words: *a detector that is itself the security boundary
fails silently on everything it does not recognise, and its recall is
unknowable.* Implementing redaction here would reintroduce precisely what was
refused, wearing the name of the thing that refused it.

That is why `ALLOW_REDACTED` refusing is not a stopgap awaiting effort. It is
the correct behaviour for a boundary positioned after rendering.

### The prerequisite is the same one purpose needs

"Explicitly not in this ADR" already says purpose-based minimisation should be
revisited *"only with declared per-task field allow-lists"*. Redaction lands on
that identical requirement by a different route. Both need:

> Labels attached to the FIELDS a prompt is assembled from, applied while those
> fields are still separate — i.e. at template-render time, upstream of the
> decision point.

With per-field labels, both become deterministic and model-free:

- **Redaction** = omit the fields whose category the destination forbids. A
  declarative set difference, not a search through prose.
- **Purpose** = (data x destination x purpose), where a purpose declares the
  fields it requires. A phone number is necessary for "send an appointment
  reminder" and unnecessary for "summarise sales performance" — expressible as
  an allow-list, and therefore testable without a model.

### Consequences for sequencing

**Redaction is not the next buildable item, and the earlier ordering was
wrong.** It sits behind field labels. Anything shipped before them is either a
detector — rejected — or a rename of the current refusal.

**Field labels are a recipe-schema change, not a privacy-engine change.**
(Declined 2026-08-30 — [ADR-0024](0024-field-level-data-labels.md).) The
work is in how a step declares its inputs, which is a larger and more visible
surface than anything ADR-0021 has touched so far, and it changes what recipe
authors write.

**The boundary may need a second decision point.** A field-level decision has to
run where the fields exist. That does not move the existing chokepoint — it
stays as the unconditional backstop on the assembled prompt — but it means the
invariant would then be enforced at two places, and the never-widen rule has to
hold BETWEEN them.

**A model must never choose the minimum.** If a model decides which fields a
purpose needs, the boundary is enforced by the thing it constrains. Purposes
declare their fields; policy decides. This is the same line the Butler work drew
when it removed an LLM judge from a scoring path.

### Not decided here

Whether field labels are worth their cost. This amendment records that two
roadmap items collapse into one prerequisite, and that the prerequisite is
bigger than either appeared alone — not that it should be built.

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

## Amendment 2026-08-27 — the operator's own choice, and what may honestly be said about it

Recorded before any code, because the scope is not settled and building the
wrong unit is more expensive than the delay. The request that prompted it:
*let people choose an approach that suits them; where a hosted model is chosen,
make it clear the data goes to that provider's servers; add privacy where it
can be added, and accept the limits.*

Three findings changed the shape of that.

### `REQUIRE_APPROVAL` has no consumer, and could not be reached anyway

`executeAgent` refuses every non-`ALLOW` decision identically. `REQUIRE_APPROVAL`
is a value the decision function can return and nothing acts on — there is no
prompt, no queue entry, no pause. "Ask me each time" is not configuration that
was never switched on; it is unbuilt.

It is also unreachable as the rule table currently stands. Rule 1 returns
`LOCAL_ONLY` whenever any local destination accepts the classification, and
that test runs BEFORE the `approvable` test. `local-models` accepts `personal`,
so a `personal` step on a hosted destination resolves `LOCAL_ONLY` every time
and never reaches the approval branch. Wiring a prompt without reordering rule 1
would produce a feature that is switched on and never fires — the exact shape of
defect this repository spent 2026-08-26 removing five instances of.

### Prompt redaction stays rejected, and outside evidence agrees

The 2026-08-18 amendment refused redaction at the decision point because the
prompt is already rendered, so removal could only mean detection, whose *"recall
is unknowable"*. Surveying the outside state of the art in 2026 did not weaken
that; it strengthened it. Production redaction stacks need per-domain custom
recognizers, miss names in prose without NER, degrade on non-US identifier
formats, and no vendor claims their output is anonymised. One further point is
specific to an agent runtime and sharpens the case: a single task fans out into
many model calls, and every hop is a fresh opportunity for personal data to
enter from a TOOL RESULT rather than from the original prompt. A detector placed
at the first hop would not see it.

So "add privacy where you can" must not become prompt scanning here. It would
present as protection and function as a guess. The honest path to redaction
remains the one already recorded: per-field labels applied at render time, which
turn removal into a set difference. That is a recipe-schema change and is still
not decided.

**DECIDED 2026-08-30 — declined, with a trigger to reopen. See
[ADR-0024](0024-field-level-data-labels.md).** Not because the design is wrong;
the workable shape is recorded there rather than discarded, including the
observation that makes it viable at all (removing a value the renderer itself
placed is bookkeeping, not detection). It is declined because `ALLOW_REDACTED`
has been returned **0 times in 254 recorded decisions** — the capability would
implement a branch that has never fired — and because the 58-of-77 undeclared
population that motivated deriving labels rather than declaring them is now
**0 of 74**. `ALLOW_REDACTED` continues to REFUSE. Reopen on the ledger, not on
the argument that redaction would be useful.

### A disclosure that states provider behaviour will rot into a lie

The obvious implementation of "make it clear where the data goes" is a sentence
about the provider's handling. That sentence decays without anyone touching the
code. Anthropic reduced API retention from 30 days to 7 in September 2025, does
not train on API inputs, offers zero-retention agreements to some customers, and
announced in August 2026 a further change requiring 30-day retention for its most
advanced models on customer-controlled infrastructure. Any string baked in today
describing that is a claim the code cannot keep.

**A boundary may only assert what it can verify.** What this runtime knows for
certain is that the prompt leaves the machine and reaches a named provider over
the network. That is true permanently and needs no maintenance. Anything about
retention, training or deletion is the provider's claim, not ours, and belongs in
an operator-editable note carrying the date it was last checked — so a stale claim
looks stale instead of looking authoritative.

This is the same rule the receipts already follow by refusing to hold a payload:
record what is known, decline to assert what is not.

### What is DECIDED

- Prompt-scanning redaction is not implemented here. Closed, not deferred.
- Any disclosure ships only the verifiable half: this leaves the machine, and
  goes to this named provider. Provider-behaviour claims are operator-supplied
  and dated.
- The choice belongs to the OPERATOR, expressed in their own configuration —
  not to a recipe author, and not to whoever wrote the step. A recipe that could
  widen its own destination policy would make the policy advisory.

### What is NOT decided, and blocks the build

**1. Granularity.** Clearing a hosted destination for `personal` clears it for
every `personal` step at once. Measured 2026-08-27: 12 steps declare `personal`,
3 `restricted`, 2 `confidential`. A per-destination switch is one line of config
and is blunt; a per-step or per-recipe opt-in is precise and is a schema change.
Choosing the blunt one first is hard to walk back in a repository that cannot
withdraw a published policy.

**2. Unattended runs — the trap.** Eleven of those twelve `personal` steps sit in
DISABLED recipes, and nine of the disabled ones are scheduled. If they are
enabled and a step resolves "ask" at 06:00 while nobody is awake, the approval
expires and the run fails. Falling back to local silently is consent theatre —
the operator is recorded as having chosen to be asked, and was not. Failing every
morning is useless. There is no defensible default, which means "ask" may not be
a third option at all so much as a property of how a recipe is TRIGGERED. That
distinction has to be settled before the queue wiring, not after.

**3. What an approval prompt may display.** A prompt asking "may this be sent?"
is meaningless unless it shows what is being sent — but receipts hold no payload
precisely because a privacy log full of prompts would be the largest unprotected
copy of the protected material. Displaying transiently and never persisting is
defensible and is a decision, not an implementation detail.

### Sequencing

Exactly one step declaring above-`internal` data sits in an enabled recipe today.
A consent subsystem built for that population would be a reader built ahead of its
evidence, which this repository has already recorded as a mistake twice. The
disclosure and the operator switch are small and can ship once granularity is
chosen; the prompt, the queue wiring and the display policy wait for a second live
step or for the scheduled recipes to be enabled.


## Amendment 2026-08-30 — orchestrator enforcement, on a path-level default

The section above left orchestrator dispatch out of scope and named exactly what
would bring it in: *"a per-task label, or a workspace-level default that is
recorded honestly as a default rather than as a declaration"*, with the receipt
shape obliged to distinguish `declared` from `assumed`. It then deliberately
declined to choose between the two, on the grounds that the choice was being
made from zero measurements and the volume should make it.

**The volume made it.** Measured on the reference machine's
`privacy_shadow.jsonl`, 19–30 August: **10 orchestrator dispatches against 288
recipe agent steps**, ~3% of observed traffic, all resolving to a single remote
destination.

At that share, a per-task label is the wrong instrument. An optional field on a
free-form prompt is a field that goes unfilled, and a declaration channel which
is mostly empty is worse than none: it manufactures rows that look like operator
intent and are not. So the amendment takes the second option.

### What changed

- **`privacy.orchestrator.classification`** — a workspace-level classification
  for the whole path. Its presence is the opt-in to enforcement. Absent, the
  path is observed and ungoverned, exactly as it has been since #1397, so no
  existing install changes behaviour by upgrading.
- **`labelSource` gains a third value, `default`.** Not a synonym for either
  existing one. `declared` means an operator classified THIS dispatch;
  `assumed` means nobody said anything and the runtime fell back; `default`
  means an operator classified the CHANNEL. Folding `default` into `declared`
  would assert intent about a prompt no operator saw — the precise claim this
  ADR refused to make. Folding it into `assumed` would erase the only operator
  statement on the path and make enforcement look like the runtime helping
  itself to a label.
- **`labelSource` is now on the RECEIPT**, not only the shadow row. It was on
  the shadow ledger from #1397 and absent from the enforcing one, so the log
  that says what actually happened could not distinguish an operator's label
  from the runtime's fallback. That was the receipt-shape requirement this ADR
  set as a precondition, unmet until now on the path that already enforced.
- **A refused dispatch fails the task** with `InformationBoundaryRefusal`. Not a
  new lifecycle state: `error` with a named cause, because adding a `refused`
  status reaches persistence, the dashboard and five MCP tools for a
  distinction the message already carries.

### What deliberately did NOT change

- **No detection.** Nothing scans a prompt. The classification comes from
  config; the decision stays a pure function of (classification, destination).
  The ADR's rejection of detection as a boundary stands unamended.
- **No per-field labels, no redaction, no purpose.** Those remain deferred
  behind the same prerequisite — labels on the fields a prompt is assembled
  from, at render time — which is a recipe-schema change and is still not
  decided. `ALLOW_REDACTED` still refuses.
- **Inert by default.** Two independent opt-ins are still required: a registered
  destination AND the orchestrator key. Either alone enforces nothing.

### Two failure directions, chosen opposite ways

A malformed `privacy.orchestrator.classification` — a typo, an unknown
classification — resolves to NOT ENFORCING, against the usual fail-closed
instinct. Failing closed on a misspelling would refuse every orchestrator task
on the machine, including the automation hooks an operator depends on, and the
remedy would be invisible from the symptom. `patchwork privacy destinations`
reports a misconfigured registry; a bridge that dispatches nothing does not.

A receipt that cannot be WRITTEN, by contrast, does not reopen the boundary. The
record is wrapped; the refusal is outside the wrapper. An enforcement that
swallows its own errors is an enforcement that silently stops enforcing.

### Ordering, which is load-bearing

The shadow observation runs BEFORE enforcement, so a refused dispatch is still
observed. A refusal is exactly the traffic a candidate policy is being evaluated
against; enforcing first would drop those rows and leave the shadow report blind
to its most interesting case. Relatedly, the shadow row now evaluates against
the operator's path classification when one exists, and stamps `enforcing: true`
— it previously hardcoded `false`, which would have told
`patchwork privacy shadow` that no live policy was enforcing while one was.

### Still open, unchanged by this amendment

`REQUIRE_APPROVAL` remains unreachable — rule 1 returns `LOCAL_ONLY` before
`approvable` is tested — and an approval expiring at 06:00 against a scheduled
recipe still has no defensible default. Enforcing a second path does not make
either question easier, and answering them inside this change would have bundled
a decision about approval semantics into one about scope.

`src/__tests__/boundaryScope.test.ts` is inverted in the same commit: it now
fails if orchestrator dispatch LOSES its boundary decision, and still fails if
the recipe path does, so it cannot pass by both sides being empty.
