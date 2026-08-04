# The Governed Workspace — Scope and Build Sequence

**Status:** planning document, 2026-08-04
**Companion ADRs:** [ADR-0019](adr/0019-open-core-boundary.md) (what is free and
what is not), [ADR-0020](adr/0020-per-member-authentication.md) (the identity
seam this whole sequence waits on).

This document scopes the *governed workspace*: one place where an organisation
can see what its AI workers are responsible for, what they may do, what needed
a person's approval, what evidence supported it, and what actually happened.

It deliberately contains no pricing, packaging, customer names or revenue
sequencing. Those live outside every repo. This is the engineering scope only.

## The finding that shapes everything below

**The governed workspace is not a new product surface. It is the attribution
chain closing.**

Four of its five subsystems are already built, merged and tested:

| Subsystem | Where | State |
|---|---|---|
| Autonomy gate (trust × action class, three terminal states) | `src/workers/` | Shipped, flag-gated |
| Forbid rules (no approval unlocks) | `src/workers/forbidPolicy.ts` + `forbids:` manifest field | Shipped (#1231, #1249) |
| Control boundary (may do now / needs approval / not permitted) | `src/workers/previewActions.ts`, `boundaryPreview.ts` | Shipped (#1241–#1244) |
| Durable approvals | `src/approvalPersistence.ts` | Shipped (#1245, #1246) |
| Workspace identity | `src/identity/` | **Built, not wired** |

The fifth is the one that matters. `src/identity/` is 480 lines implementing six
roles, a capability matrix, and a segregation-of-duties check that runs the
self-approval test *before* the capability test — because an owner holds
`action.approve`, so testing capability first would report an owner approving
their own work as allowed. It is careful, tested code.

Nothing calls it. `loadRoster` and `describeRoster` are imported by `bridge.ts`
and held on `server.roster`. `canApproveAction` is referenced by its own module
and its own tests, and by nothing else in the tree.

It cannot be called, because **no request that reaches the bridge carries a
subject.** The bridge authenticates one shared bearer token. The dashboard
session cookie's signed payload is, literally, the expiry:

```ts
// dashboard/src/lib/session.ts
const payload = `v1.${expiresAt}`;
```

That is not "the cookie lacks a subject field". There is no field but expiry.
Every approver is indistinguishable at the auth layer, so the roster has real
members and no way to know which one is acting.

### What that single gap costs

Each of these is blocked by the same missing subject, not by its own difficulty:

- **Segregation of duties** — implemented, tested, and unreachable.
- **Attributed decision records** — ADR-0017 added an optional `actor` snapshot
  to `GateDecisionRecord`. It is permanently absent, correctly: the only actor
  we could write would be invented, and ADR-0017 forbids exactly that.
- **Signed evidence export** — an export stating that an action was approved but
  not by whom is not evidence. It is a log with a signature on it.
- **Approval routing** — there is nobody to route to.

This is why the sequence below is *one prerequisite and then four things that
become possible*, rather than five parallel workstreams. Any plan that treats
per-member authentication as one item among several produces quarters of work
that cannot be defended to a buyer, because every question a buyer asks — who
approved this, can you prove policy was followed, can you show an auditor —
resolves to the same missing subject.

## Four states, kept separate

Credibility depends on not blurring these. Each claim below is verified against
code, not against planning notes.

### Proven today

- Local runtime, IDE bridge, recipes, connectors, tools.
- Autonomy gate with three terminal states (`allow` / `gate` / `forbid`),
  per-`(worker × actionClass)` Bayesian trust, descending-only context ceiling.
- Forbid rules with an operator-facing `forbids:` manifest field.
- Control boundary computed by the bridge and rendered — never re-derived — by
  the dashboard, with a test asserting preview and gate agree for every
  candidate under several rule sets.
- Durable approval requests surviving restart; restored entries visible as
  `pending, unowned`.
- Decision records with `gatePolicyVersion`, written append-only to
  `~/.patchwork/worker_gate_decisions.jsonl`.
- Kill switch, rollback of `file.write`/`file.append` side effects, flight
  recorder and mocked replay.

### Being validated now

- Whether the installed base is active, not merely downloaded.
- Whether users will pay for operation rather than self-host.
- Which control an organisation actually requires before Patchwork may touch
  production. Do not assume it is SSO; it may be retention, evidence integrity,
  private deployment, or procurement.

### Buildable within two quarters

- Per-member authentication ([ADR-0020](adr/0020-per-member-authentication.md)).
- Attributed decision records — the actor field stops being absent.
- Enforced segregation of duties — wire the `canApproveAction` that exists.
- Approval routing to a named person or role.
- Signed, verifiable evidence export.
- Organisation-wide policy inheritance and retention.

### Options, not commitments

- Finance exception and assurance workflows.
- OEM and embedded partnerships.
- Third-party-recognised attestation.
- Cross-organisation governed automation.

Nothing in the last two groups should be described as existing.

## Build sequence

### Phase 0 — parity (unblocked)

`../patchwork-multitenant` vendors this repo's `src/` verbatim and last synced
at #1194. Measured today: 65 files differ, 40 exist on only one side, and all
five governance subsystems above are **absent** from the tenant image. Every
tenant runs without forbid, without the control boundary, and without durable
approvals.

Scope: port the five subsystems and the `forbids:` field, verify each, leave the
remaining drift for a later pass. A smaller reviewable PR closes the real
correctness gap; full parity can follow.

State this plainly in the PR: **Phase 0 ships a tenant image that has forbid,
boundary and durable approvals, and still cannot name anyone.** It closes a
correctness gap, not a commercial one.

### Phase 1 — identity (the critical path)

Per-member authentication behind a pluggable seam resolving to `members.json`.
Local credentials first so a laptop install gets attribution with no IdP; OIDC
second, mapped on `sub`. Full reasoning and the rejected alternatives are in
[ADR-0020](adr/0020-per-member-authentication.md).

Nothing else on this list should start before this lands. Not because the other
work is hard, but because each piece of it is finished by identity and unfalsifiable
without it.

### Phase 2 — what identity unlocks

These are genuinely parallel once Phase 1 exists:

1. **Attributed decision records.** Populate ADR-0017's `actor` snapshot from
   the authenticated principal. Absence must remain distinguishable from
   unknown — never backfill.
2. **Enforced segregation of duties.** Call `canApproveAction` at the approval
   path. The function is written; this is wiring plus the refusal UX.
3. **Approval routing.** Route a pending approval to a member or role, with the
   risk-tiered timeouts that already exist.

### Phase 2b — the two foundations attribution alone does not supply

Identity closes the *who*. Two structural gaps remain, and neither is unlocked
by it:

**A durable store.** There is no database. Postgres appears in
`src/recipes/tools/postgres.ts` as a *connector* — something the product reads
on a customer's behalf — never as the bridge's own store. Everything the bridge
remembers is JSONL under `~/.patchwork` with flock and rotation. That is good
engineering for one machine and not an organisation's record. Recommended shape:
embedded SQLite in the workspace directory, WAL mode, behind a repository
interface, with JSONL retained as the append-only export path — it is the
tamper-evident format and the CLI already reads it. SQLite over Postgres because
the single-tenant product is one bridge, one workspace, one process, and its
selling point is that it runs locally; the hosted product's Postgres is a
separate question living in a separate repo.

**A case object.** Approval today is per *tool call*. A case is one question, its
scope, its evidence set, a *bundle* of proposed actions approved selectively,
and a lifetime measured in days. This is the object that makes several areas of
work one workspace rather than several folders, and it is what a signed export
is an export *of*.

Both are prerequisites for Phase 3, not refinements of it. Sequencing note that
matters: build the records before any view over them. A dashboard over records
that do not exist is a slide, and it is the easiest way to spend a month and
have nothing that compounds.

### Phase 3 — organisation scale

Policy inheritance, retention enforcement, signed evidence export, the
attestation seam. Ordered by what Phase-0/1 customer interviews actually
surface, not by our confidence.

One rule worth stating because it is easy to violate under deadline: **a record
in our store may reference an external system but must never become the second
source of truth for it.** Authoritative data stays in its source system; we hold
a reference, a hash, a timestamp, and who could see it.

## The seam that keeps the boundary honest

One architectural rule holds the open-core line ([ADR-0019](adr/0019-open-core-boundary.md)):

> **The open runtime emits evidence. Only the commercial control plane can
> attest to it.**

Concretely: the decision records, approval log, outcome log and rollback ledger
stay open-format and locally written — that is the free product and the funnel.
The bridge gains one small MIT-licensed export interface that streams those
records outward. Countersigning, hash-chaining, off-site retention and the
auditor-facing export belong to the control plane.

A fork can replay its own logs. It cannot produce a record a third party will
accept, because that requires an operator who signs a contract about the record.
That is a difference open source cannot erase, which is precisely why the line
is drawn there and not somewhere more convenient.

## Carrying a lesson forward

Three bugs in the session that produced the boundary work were the same shape:
the thing built worked, and the adjacent thing that had to agree with it did
not. Forbid rules reached the preview but not enforcement, then not the agent
sandbox; invalid rules were discarded at both call sites.

This sequence is unusually exposed to that failure mode, because identity must
hold in the bridge, the dashboard, the tenant image and the decision record
simultaneously. Two rules follow:

1. When a rule must hold in more than one place, check every path — and prefer
   deriving configuration at the point of use over threading it through call
   sites that can forget.
2. Drive the actual UI. "Merged" and "working" are different milestones, and the
   gap between them has been found by clicking, not by reading.
