# ADR-0024: Field-Level Data Labels — Considered and Declined, With the Trigger to Reopen

**Status:** Rejected (2026-08-30). Revisit on the trigger below, not on taste.
**Date:** 2026-08-30
**Amends:** [ADR-0021](0021-information-boundary.md) — closes a deferral that had
been open since the boundary shipped.

## Why this document exists

ADR-0021 defers two capabilities — field-level redaction and purpose
minimisation — behind one prerequisite, and names it identically both times:

> Redaction and purpose both sit behind the same prerequisite: labels on the
> FIELDS a prompt is assembled from, applied at render time. That is a
> recipe-SCHEMA change, and it is NOT decided.

"NOT decided" has stood unchanged since. An open deferral with no verdict is not
free: it gets re-scoped from scratch each time someone reaches the same wall, and
each re-derivation costs the same investigation. **This ADR closes it with a
`no`, so the next person inherits the reasoning instead of rebuilding it.**

A `no` here is not a judgement that the design is bad. A workable design exists
and is recorded below, because the reason for declining is about evidence and
evidence changes.

## The measurement that decided it

Taken 2026-08-30 on the reference machine.

| | |
|---|---|
| Boundary decisions recorded | 254 |
| Window | 2026-08-19 → 2026-08-30 |
| `ALLOW` | 248 |
| `LOCAL_ONLY` | 6 |
| **`ALLOW_REDACTED`** | **0** |
| `DENY` | 0 |
| `REQUIRE_APPROVAL` | 0 (nobody has set `approvable` — see below) |

**`ALLOW_REDACTED` has never once been the answer.** The entire capability this
prerequisite gates would implement a decision that has not occurred.

All six non-ALLOW decisions are `LOCAL_ONLY`, and every one of them comes from a
recipe whose purpose is to exercise the boundary rather than to do work. No
operator recipe has been stopped. (Named in `patchwork privacy receipts` on the
machine; not reproduced here — that ledger's contents are operator data, so the
measurement travels and the rows do not.)

The second figure that changed the answer: **0 of 74 agent steps carry no
`data_policy`**, across 72 installed recipes. `CLAUDE.md` said 58 of 77 and that
was the motivating population for deriving labels rather than declaring them.
The sweep completed; the population is gone. Anything scoped against the 58
figure is scoped against a number that no longer exists — check
`patchwork privacy undeclared` before quoting it, including quoting this ADR.

## The decision

**Do not build field-level labels now.** `ALLOW_REDACTED` continues to REFUSE.

This is ADR-0021's own rule applied to itself — *"do NOT build the readers ahead
of the evidence"* — and it is the same reasoning that keeps
`permission_exercises.jsonl` unjoined: the file is absent because no standing
permission has ever been granted, and building a join for it would be building
against nothing. Zero redaction decisions is the same shape of nothing.

The cost side is not marginal. The design below is a schema change, a lint
surface, a renderer change, a derivation step, a redactor with its own failure
modes, and a migration story for 72 installed recipes — to implement a branch
that has fired zero times out of 254.

## The trigger to reopen

Reopen when **`ALLOW_REDACTED` is being returned for real operator recipes** —
not probe recipes — at a rate that makes refusing them an availability problem.
Concretely: `patchwork privacy receipts` showing a non-zero `ALLOW_REDACTED`
count whose `refusalsByRecipe` names recipes doing actual work.

That is a measurement anyone can take, which is the point. "It feels like we
need redaction" is not the trigger; the ledger is.

**Do not reopen on the argument that redaction would be nice to have.** It would.
So would purpose. The question this ADR answers is whether the evidence supports
paying for it yet, and today it does not.

## The design, recorded so it need not be re-derived

Kept deliberately. If the trigger fires, this is the shape — and the first
observation is the one that took the longest to reach:

**Redaction at render time is not detection.** `render()`
(`src/recipes/yamlRunner.ts:3239`) is pure `{{key}}` substitution over
`RunContext`, which is `Record<string, string>`. Every character of a rendered
prompt came from either a literal the recipe author typed or the value of a named
context key the renderer itself interpolated. Finding a mailbox in prose is
detection and its recall is unknowable — the thing ADR-0021 rejects. Removing the
value of `{{inbox}}` at the offset the renderer just wrote it to is bookkeeping:
we delete what we placed, whose extent we know because we produced it. Recall is
total by construction over the labelled keys.

That is why the prerequisite ADR-0021 named is the right one, and why it must
happen at render time: one layer later, at `executeAgent`, the provenance is gone
and only detection remains.

The shape:

1. **Labels attach to context keys** (`into:` names and `vars`), not to steps —
   that is the namespace the renderer already resolves against, so a label naming
   a key no step produces is a lint error rather than a silent no-op.
2. **A step's classification is derived** via the existing `narrowest()` over the
   keys the renderer *actually interpolated* — from the renderer, never a regex
   over the template, because a conditionally-referenced key may contribute
   nothing.
3. **Redaction is per-key, never per-substring.** If a labelled value appears for
   a second reason, the redactor does not go looking; going looking is detection.
4. **A key whose value cannot be located at dispatch REFUSES.** Never
   "best-effort". A prompt that was supposed to be redacted, was not, and was
   sent anyway is the one outcome that must not exist.
5. **`labelSource` gains no fourth value.** A derived label is `declared`.

### Three things this design does NOT solve

- **Tool outputs are not operator-labelled.** A connector returns third-party
  data into a context key, and an operator labelling that key labels a container
  whose contents they have not seen. A per-tool default table is the obvious
  answer and it is an *assertion* — the class of claim ADR-0021 refused for
  orchestrator prompts. Such keys would need `labelSource: "default"` and
  separate reporting, exactly as the orchestrator path now has.
- **The chained runner may not share this render path.** The design above is
  written from `yamlRunner.render` and was not verified against the chained
  runner. Verify before scheduling, or this closes one of two runners and reports
  as though it closed both.
- **Literal text carries no label and cannot.** An author who pastes sensitive
  material into a prompt literal is invisible to all of this. Coverage here is
  enumerated, never total, and must be described that way or it reads as
  reassurance.

## Purpose minimisation

Also declined, and not merely by association. Purpose asks *why* a destination is
receiving something — a question about intent rather than provenance — so it does
not follow from the design above even if that design were built.

## Not addressed here

**`REQUIRE_APPROVAL`'s zero.** An earlier draft of this ADR said the decision was
*unreachable* — that rule 1 returns `LOCAL_ONLY` before `approvable` is tested,
so a destination that could ask a human never does. **That claim is wrong**, and
it is recorded here rather than quietly corrected because it arrived in handoff
notes and was repeated three times, into this document, before anyone ran it.

`REQUIRE_APPROVAL` fires whenever an uncleared destination is `approvable` and no
local destination accepts the classification. The zero above has a simpler cause:
**no destination on the reference machine sets `approvable` at all.**

What *is* true is narrower and is a real defect: on a registry with a permissive
local destination — the recommended shape — the `approvable` flag on a remote
destination can never fire, because `localDestinationAccepts` is then always
true. An operator sets a control expecting to be asked and is refused instead,
since `LOCAL_ONLY` declines rather than rerouting. That is reported by
`patchwork privacy destinations` and is deliberately not fixed by reordering,
which would make live traffic newly approvable.

Neither is fixed by this ADR. The open question that remains genuinely open is
what an approval expiring at 06:00 against a scheduled recipe should default to.

## Alternatives considered

- **Require `data_policy` on every agent step (absence is an error).** Now moot:
  0 of 74 are undeclared, so the gate would be a no-op that can only fail on
  recipes not yet written. Worth revisiting as a *ratchet* to stop the population
  regrowing — cheap, and unrelated to redaction.
- **Scan the rendered prompt.** ADR-0021's stated rejection, unchanged. Any
  proposal ending "and then we scan for it" is that design wearing a schema.
- **Build it anyway, ahead of demand.** Rejected on ADR-0021's own rule. The one
  case where building ahead of evidence is correct in this repo is `pr-outcomes`,
  because outcome history accrues only with wall-clock time and a day not
  recorded cannot be recovered. Redaction has no such property: the decisions are
  recorded either way, and building the redactor later loses nothing.
