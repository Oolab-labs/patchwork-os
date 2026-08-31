# ADR-0025: The Evidence Spine Is a Constraint, Not a Subsystem

**Status:** Accepted
**Date:** 2026-08-31

## Context

Six ledgers record what this runtime did. Each is individually sound and they
mostly do not join:

| Ledger | Records |
|---|---|
| `worker_gate_decisions.jsonl` | what a worker was allowed to do, and why |
| `boundary_receipts.jsonl` | what a model destination was allowed to receive |
| `approval_log.jsonl` | what was queued for a human, what they decided, who they were |
| `privacy_shadow.jsonl` | what a candidate policy *would* have stopped |
| `outcome-log.jsonl` | whether a filed action turned out to be real |
| `worker_trust/` | the derived trust dial, checkpointed per recipe |

Measured with `patchwork evidence` on the reference machine, 2026-08-31: gate
decisions **8 of 280** rows carry a run reference, boundary receipts **108 of
264**, `privacy_shadow` **0 of 309**, `outcome-log` **0 of 99**, `approval_log`
**0 of 215**. Runs reachable in more than one ledger: **1**.

That last number is the whole problem stated as a scalar. Every ledger can
answer a question about itself. Almost nothing can answer a question that spans
two — which is the only shape a question from outside the system ever takes.
"Who approved the thing that was decided at 10:42, under which rule, and has the
record changed since" is four ledgers and a join.

This has been written down before, as a section of `CLAUDE.md`. That section
records, in its own text, that both of its load-bearing claims went stale or
were wrong within two days of being written. On 2026-08-31 a third claim in the
same neighbourhood was found false — the assertion that zero attribution rows
existed anywhere, which had cleared some days earlier and was still being quoted
as a live blocker while work was scoped around it.

A principle that keeps decaying in a file nobody diffs is not recorded. It is
merely written. That is what this ADR is for: the principle is stable even
though every measurement of it is perishable, and the two need to live in
different places.

## Decision

**1. The spine is a review criterion, not a backlog item.** Nothing here is a
thing to go and build. Every consequential operation should progressively become
attributable to a stable member, worker, policy, tool, model destination,
decision, approval and observed outcome. A change is reviewed for whether it
strengthens, weakens or bypasses that chain. Six good subsystems converging is
the goal; six disconnected ledgers is the default outcome if nobody applies the
criterion.

**2. Absence is meaningful and is never backfilled.** "Nobody recorded this"
must stay distinguishable from "we do not know." This is doctrine inherited from
`workerGateDecisionLog.ts` and it is the constraint that makes the rest hard:
stamping a correlation id onto new rows without a sentinel turns every existing
row into a permanent orphan that no reader can tell apart from a future row
which legitimately had no run. Two different absences collapse into one,
silently, and the collapse cannot be undone.

So: **design the sentinel, then stamp.** Never the other way round, and never
"we can fix the old rows later" — that sentence is the bug.

**3. `rv` is the stamping protocol.** A schema-version sentinel on the row, not
an inference from which fields happen to be present. A reader may not assume a
counter's meaning is stable across versions, so a row from another `rv` is
skipped rather than diffed across. Proven twice: gate decisions (#1519) and
boundary receipts (#1522), in both cases with the pre-existing rows hashing
byte-identical and carrying no `rv`.

**4. The correlation id is the run's `taskId`, never `seq`.** `seq` is a
per-instance counter and the run log is shared by eight construction sites;
142 of 145 seqs collided in one live sample. A join key that collides is worse
than no join key, because it produces confident wrong answers.

**5. Do not build the readers ahead of the evidence.** A cross-ledger graph, a
replay surface or a unified query UI built now would be a view over data that
does not exist, and the shape of the view would then dictate the shape of the
evidence — backwards. Preserve the evidence; readers are cheap once it is there
and expensive to retrofit once it is wrong.

**6. `approval_log.jsonl` is the next ledger to stamp, and it is not merely the
next one in a list.** It is the ledger an outside party asks for first, and at
0 of 215 no run in the entire history can be assembled into an answer about who
approved what. It is also the ledger where the ordering trap from ADR-0020
already applies: the `decision` row is written before the approver is resolved,
so the run reference must be stamped without letting identity resolution block
or alter the approval. Expect the dep-builder ordering problem that
`boundary_receipts` hit — a ledger written from a builder that runs before the
run id exists needs a cell filled by the runner, not a field filled on the easy
path only.

**7. What is explicitly NOT decided, with the reason each was left open:**

- **`outcome-log.jsonl`** — the hazard is meaning, not plumbing. A disposition
  is recorded by a later run, or by an operator at a CLI, about an action
  performed by an *earlier* one. A bare `correlationId` would be ambiguous
  between "the run that filed this" and "the run that judged it." Two facts
  under one field name is exactly what the `rv` protocol exists to prevent, so
  name it for what it is or leave it off.
- **`worker_trust/`** — checkpoints are derived state, not an event stream. A
  correlation id belongs on the events folded in, not on the snapshot.
- **`butler/permission_exercises.jsonl`** — the file is absent because no
  standing permission has ever been granted. Its absence is correct. This is
  point 5 with a concrete instance attached: do not plumb a join for a ledger
  that has nothing in it.
- **Tamper-evidence (per-row `prevHash` chaining).** Not decided here.
  Chaining is not attesting — a chain proves a record is unchanged, an
  attestation vouches that a third party received it — so chaining does *not*
  cross the ADR-0019 line and could live in the open runtime without giving the
  commercial surface away. It is left open because it is a wire-format change to
  every ledger at once, which is precisely the class of change point 2 says must
  be designed before it is applied. Decide it as its own ADR.

## Consequences

**Every new ledger, and every new writer on an existing one, inherits four
obligations:** carry `rv`; key on `taskId`; treat absence as absence; and make
the reader enumerate fields deliberately. That last one is not hypothetical —
`view()` in `boundaryReceipts.ts` enumerates fields explicitly, so both new
fields would have been silently dropped on read, which is #1517's defect
exactly and was caught only because someone checked. A writer landed without its
reader is indistinguishable on disk from a feature nobody used.

**Coverage is enumerated, never asserted as total.** A join that covers part of
a surface must say which part. A crossing count over a partial surface reads as
"your policy is fine" when it partly means "we did not look."

**Measurements go in the verb, not in prose.** `patchwork evidence` exists so
that no document has to carry a number that rots. Every figure in this ADR is
stamped with the date it was taken and is expected to be wrong later; the
decisions are not. Anything scoping work off a number here must re-run the verb
first. Three separate stale figures in `CLAUDE.md` are the evidence that this
instruction is necessary rather than decorative.

**The verb's output is safe to quote.** `patchwork evidence` prints counts only
— never a row, an id or any value — because a `correlationId` is a run's
`taskId`. This is deliberate and must survive refactoring: `runstore compare`
and `privacy receipts` print operator data and are *not* safe to quote, and a
health check is the last place anyone thinks to look for accumulated secrets.

**What this unblocks, and what it does not.** With `approval_log` stamped, an
end-to-end record — proposed, governed, approved by a named person, outcome
observed — becomes assemblable for the first time. That is the precondition for
anything an outside auditor could check, and it is currently the binding one:
not signing, not storage, not a UI. It does not by itself make the record
tamper-evident, and it does not make it independently vouched for. Those are
ADR-0019's line and are correctly on the other side of it.
