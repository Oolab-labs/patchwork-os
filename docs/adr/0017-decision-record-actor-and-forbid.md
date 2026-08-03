# ADR-0017: Decision Records Name Their Actor, and a Third Terminal Gate State

**Status:** Accepted
**Date:** 2026-08-03

## Context

Two changes are queued against the same persisted records, and doing them
separately would migrate the same file twice.

**1. No persisted record names a human.** `GateDecisionRecord`
(`src/workerGateDecisionLog.ts`) carries `workerId` — the *non-human* actor —
and nothing else identifying who was involved. `DecisionTrace`
(`src/decisionTraceLog.ts`) carries `sessionId` at best. In `approvalQueue.ts`
the word "approver" appears only in comments about single-use token handling,
never as a stored field. The bridge authenticates a single bearer token
compared with `timingSafeEqual`; OAuth mode binds a session to a token hash.
Neither resolves to a person.

The consequence is that a decision record answers *what happened* and cannot
answer *who allowed it*. That blocks segregation of duties (the worker that
prepared a proposal must not approve it — unenforceable without identities),
and it degrades every audit conversation the gate exists to support. It is also
the one gap where delay is not recoverable: every record written before an actor
field exists can never be attributed retroactively.

**2. The gate has no third terminal state.** `GateAction = "allow" | "gate"`.
There is no way to express *never, regardless of earned trust* — an action that
must be refused at L4 with an autonomy ceiling of 4, and that no approval
unlocks. Today the closest thing is an unreachable ramp, which is a statement
about topology rather than about policy.

Both changes touch records that live in `~/.patchwork/worker_gate_decisions.jsonl`,
are append-only under a cross-process flock ([ADR-0007](0007-multi-bridge-jsonl-concurrency.md)),
and are read by `patchwork gate explain`, `patchwork workers shadow`,
`patchwork workers backtest`, `GET /gate/decisions` (`src/recipeRoutes.ts`,
`src/server.ts`) and the dashboard.

`workerGateDecisionLog.ts` states "Schema is additive." That is true for adding
a *field* and false for adding a *value* to an existing enum: a reader switching
exhaustively on `"allow" | "gate"` falls through to its default branch. Because
the log is explicitly cross-process and read with tail-on-read, the hazardous
direction is not old records read by new code — it is **new records read by an
older sibling bridge or an older CLI**.

## Decision

**One migration, one version bump, covering both changes.**

1. **`gatePolicyVersion` moves `"worker-ramp-v0"` → `"worker-ramp-v1"`** at the
   point where either an actor field or a `forbid` action can first appear. The
   field already exists on every record; it is the designed seam for exactly
   this, and it means readers branch on a declared version rather than inferring
   from an unexpected enum value.

2. **`GateAction` gains `"forbid"`** — a third terminal state meaning *no
   autonomous level is ever reachable and no approval unlocks this*.

3. **`forbid` is evaluated as a policy predicate before the trust maths**, not
   derived from ramp topology. Concretely: an `isForbidden(actionClass, params,
   policy)` check consulted ahead of `recommend()`'s level comparison, not an
   empty return from `reachableLevels()`.

4. **Decision records gain an optional actor** identifying the human or role
   that allowed the action. Optional, so every existing record remains valid
   without rewriting.

5. **No backfill.** Records written before this ADR contain neither field. Their
   absence is meaningful — it says the decision predates actor attribution — and
   is more honest than a synthesized `"unknown"`.

6. **Formatters tolerate unknown values.** `formatGateDecision` /
   `formatGateDecisionDiff` / `formatGateDecisionHistory` render an unrecognised
   action rather than throwing, so a log containing both versions is always
   readable. `src/__tests__/gateDecisionFormat.test.ts` already pins the wire
   shape and extends to cover the mixed case.

## Alternatives considered

**Two separate migrations, one per change.** Rejected: identical records, two
`gatePolicyVersion` bumps within weeks, two rounds of reader fallbacks, and two
opportunities for a sibling process to meet a record shape it does not know.
The changes are independent in motivation and identical in blast radius.

**Express `forbid` by having `reachableLevels()` return `[]`.** Rejected on two
counts. Mechanically it survives — `graduation.ts` guards `nextRung !==
undefined` — but it encodes a hard policy as an emergent property of an empty
array, and `[]` versus `[0]` is a distinction that will not survive six months
of maintenance. Conceptually it conflates two different things: `reachableLevels`
describes which ramp rungs a class can climb, while `forbid` is an assertion
about the action itself. They come apart precisely where it matters — a
forbidden action must stay refused at L4 with a ceiling of 4.

**Backfill old records with `actor: "unknown"`.** Rejected: it manufactures the
appearance of attribution for decisions that never had any. An audit reader
should be able to tell "nobody recorded this" from "we do not know."

**Make the actor field required.** Rejected: it invalidates every existing
record and forces exactly the backfill above.

**Version the file rather than the record.** Rejected: the log is append-only
and rotates, so a single file can legitimately contain both shapes. Per-record
versioning is the only thing that survives rotation.

## Implementation note — 2026-08-03: the two halves version differently

Implementing the actor field showed the "one migration, one version bump"
decision above to be half right, and the ADR is corrected here rather than
quietly diverged from.

The hazard analysis in **Context** is about adding a *value to an existing
enum*: a reader switching exhaustively on `"allow" | "gate"` falls through to
its default. That is real, and it is why `forbid` needs a declared version to
branch on.

An **optional new field is not that**. `actor` is genuinely additive in the
sense the log file header claims — an older reader parsing a record that
carries it simply ignores the key. Nothing breaks, nothing is misreported, and
no reader needs to know the version to read it correctly.

Bumping `gatePolicyVersion` for the actor field would also be a *false signal*.
Its documented meaning is the policy that produced the row — thresholds and the
reversibility→level mapping — so that a decision can be replayed against the
rules that applied. Adding a field changes no threshold. A replay tool reading
`worker-ramp-v1` would correctly infer that the policy changed, and be wrong.
(Verified at the time of writing: nothing branches on `gatePolicyVersion`; the
only consumer renders it in `formatGateDecision`. So the false signal is
currently harmless — which is an argument for not creating it, not for
shrugging.)

**Therefore:** the actor field ships at `worker-ramp-v0`, unversioned and
additive. The bump to `worker-ramp-v1` lands with `forbid`, which is both an
enum widening *and* a genuine policy change (a new terminal state the gate can
reach). One bump, attached to the change that actually earns it.

Everything else above stands: no backfill, absence stays meaningful, and the
reader-side fallback ships before the first `forbid` record — which it now has
(`describeGateAction`, `gateOutcomeFor`).

## Consequences

- Old records stay readable by new code unconditionally. New records are
  readable by older readers only via the unknown-value fallback, so the fallback
  ships **before** the first `v1` record is written, not alongside it.
- `gate explain`, `workers shadow` and `workers backtest` each need one update
  to branch on `gatePolicyVersion`. `GET /gate/decisions` and the dashboard
  render the new fields when present and omit them when absent.
- Segregation of duties becomes expressible. It is not delivered by this ADR —
  this only makes the record able to hold the fact.
- This does **not** make approvals durable. `ApprovalQueue` holds its entries in
  an in-memory `Map` with a five-minute TTL, so an approver identity captured
  there does not survive a restart. Durable approval storage is a separate
  prerequisite, and until it lands the actor field is only as persistent as the
  gate-decision log that carries it.
- `"worker-ramp-v1"` becomes the floor for any future gate-policy change; the
  next one bumps to `v2` rather than adding a second version field.
