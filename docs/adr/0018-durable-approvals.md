# ADR-0018: Durable Approvals — Persist the Request, Not the Await

**Status:** Accepted
**Date:** 2026-08-03
**Implemented:** 2026-08-04 (#1245 storage, #1246 unowned-visibility UI)

> Recorded as **Proposed** while unscheduled — its central claim, that the
> blocked caller cannot be restored, decided how much was worth building.
> Promoted to Accepted once implemented: `ApprovalQueue` now persists via
> `src/approvalPersistence.ts` (`approvalQueue.ts:7`, `bridge.ts:14`) and
> restored entries surface as `pending, unowned` in the dashboard. Attributing a
> restored approval to a *person* remains blocked on
> [ADR-0020](0020-per-member-authentication.md), not on this ADR.

## Context

`ApprovalQueue` (`src/approvalQueue.ts`) holds pending approvals in
`private readonly entries = new Map<string, Entry>()`. Nothing is written to
disk. A bridge restart — a crash, a deploy, a laptop closing — silently drops
every pending approval.

Three consequences, in increasing order of seriousness:

1. **A human who was asked is never told the question vanished.** The dashboard
   simply shows an empty queue. Nothing errors, so nobody investigates.
2. **The audit record has a hole.** A gated decision is recorded, and the
   approval that would have resolved it is not, because it never happened and
   never will. "Asked, then nothing" is indistinguishable from "never asked".
3. **A gated decision can never name its approving human** — the blocker for
   segregation of duties described in [ADR-0017](0017-decision-record-actor-and-forbid.md).

**Expiry is not the problem.** #1214 replaced the flat 5-minute TTL with
risk-tiered, live-configurable timeouts (`DEFAULT_TTL_MS`: low 5 min, medium
1 h, high 4 h; `--approval-timeout-high none` for an unbounded hold). A prior
version of ADR-0017 said otherwise and has been corrected. Durability is the
gap; timeouts already accommodate a human.

## The constraint that shapes everything

`Entry` is not serialisable, and not incidentally:

```ts
interface Entry extends PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout> | null;
  pendingPromises: Array<(d: ApprovalDecision) => void>;
  // …
}
```

A resolver is a continuation into a running `await` inside a recipe step. When
the process dies, **the thing that was waiting dies with it.** No amount of
persistence brings it back, because what would be resumed no longer exists —
the step, its stack, its in-memory context and its open handles are gone.

So "durable approvals" has to mean something narrower than it sounds.

## Decision

**Persist the request. Do not attempt to persist the await.**

1. **On enqueue**, append the request to a durable store: `callId`, `toolName`,
   `params`, `tier`, `sessionId`, `summary`, `recipeName`, requested-at, and the
   resolved expiry. This is the record an auditor needs and a human reads.

2. **On resolve**, append the decision — approve/reject, when, and (once
   identity is wired) by whom.

3. **On restart, restore pending requests as `pending, unowned`.** They appear
   in the queue, a human can still decide them, and the decision is recorded.
   What does *not* happen is resumption: no caller is waiting, so an approval
   grants nothing. The originating run must be re-run to act on it.

4. **`unowned` is visible, not silent.** The dashboard and CLI must show that a
   restored entry has no waiting caller, because "approved" on an unowned entry
   means "recorded, not performed" — and an operator who believes otherwise has
   been misled about whether the action happened. Given the whole product is
   that a person can trust what a screen tells them about authority, this label
   is not a nicety.

5. **Restored entries never auto-resolve.** Not to approved (obviously), and not
   to expired-then-denied either: a restart is not a decision, and recording one
   would put a verdict in the audit trail that no policy and no human produced.
   They restore with their original expiry; if that has passed, they resolve as
   `expired` exactly as they would have in-process.

## Alternatives considered

**Persist a resumable continuation.** Rejected as out of scope rather than
wrong. Resuming the await means making the whole recipe run resumable —
step state, context, tool handles — which is a far larger change than the
approval queue, and the repo already has the honest starting point for it in the
flight-recorder / replay machinery (`src/recipes/replayRun.ts`). Attempting it
inside `ApprovalQueue` would put run-resumption logic in the wrong module.

**Keep dropping pending approvals (status quo).** Rejected. The failure is
silent, and it is the human-facing half that is worst: someone was asked a
question, answered nothing, and was never told the question disappeared.

**Restore and auto-deny on restart.** Rejected. It is the fail-closed-looking
option and it is wrong for the same reason auto-approve is: a restart is not a
decision. Writing `denied` claims a judgement nobody made, and a denial in an
audit trail is a fact about a person, not about a process.

**Write only decisions, not requests.** Cheaper, and it loses the case the
record exists for: an approval that was *asked and never answered* is exactly
the interesting one, and it leaves no decision row.

## Consequences

- Needs a durable store. `~/.patchwork` JSONL matches the four existing logs and
  ADR-0007's concurrency model; embedded SQLite is the better long-term answer
  and is a larger decision than this ADR (the queue is mutable, unlike the
  append-only logs, so JSONL requires a compaction or tombstone story).
- `ApprovalQueue` gains a persistence seam and a restore path. Both must be
  fail-soft on write — a logging failure must never block a live approval, the
  same rule the gate-decision log already follows.
- A restored-but-unowned entry is a new state the dashboard, the phone path and
  `gh`-style CLI output all have to render. This is the bulk of the work, and it
  is UI, not storage.
- Once requests persist, a gated decision can carry its approving human, and
  segregation of duties becomes enforceable rather than merely expressible.
- Nothing here changes timeout behaviour. #1214's tiers stand unmodified.
