# ADR-0019: The Open-Core Boundary — Emit Here, Attest There

**Status:** Accepted
**Date:** 2026-08-04

## Context

This repository is MIT licensed and should stay that way. The bridge and runtime
are the distribution channel; charging for what is already published would
weaken adoption, invite forks, and take from the existing audience something it
already has.

The problem is not that decision. It is that **there is currently no rule about
where the line falls**, and the default behaviour puts governance features on
the free side by accident.

`../patchwork-multitenant` is the natural home for anything organisation-scale:
it already holds tenant provisioning, per-tenant containers and the dashboard.
It is also **MIT licensed**, and it vendors this repo's `src/` verbatim into the
tenant image. So organisation identity, policy inheritance, durable off-site
evidence and signed audit export — the four things an organisation is most
likely to pay for — would ship MIT simply by being built where they naturally
belong. Nobody would have to decide that; it happens by default.

A published MIT commit cannot be withdrawn. The cost of noticing this late is
not a refactor, it is a permanent loss of the thing being protected.

## Decision

**Three repositories, with the licence boundary drawn between the second and
third.**

| Repository | Licence | Contents |
|---|---|---|
| `Patchwork OS` (this repo) | MIT, unchanged | Runtime, bridge, recipes, tools, connectors, local approvals, the single-workspace gate, the boundary computation, evidence *emission* |
| `patchwork-multitenant` | MIT, **scope frozen** | Tenant provisioning, reverse proxy, per-tenant container plumbing. Infrastructure, not governance |
| `patchwork-control-plane` (new) | Non-MIT (BSL 1.1 or similar) | Organisation identity (SSO/SCIM), policy inheritance, off-site tamper-evident evidence store, signed audit export, approval routing, cross-workspace worker registry, retention enforcement |

The architectural rule that keeps this honest:

> **The open runtime emits evidence. Only the commercial control plane can
> attest to it.**

Concretely:

- `worker_gate_decisions.jsonl`, `approval_log.jsonl`, `outcome-log.jsonl` and
  `file_rollback.jsonl` stay open-format and locally written. They are the free
  product and the funnel, and they must remain fully usable alone.
- This repo gains **one** MIT-licensed export interface: a signed-shipment
  endpoint streaming those records outward. It is deliberately small and
  deliberately open — a closed export format would be a lock-in tactic rather
  than a moat.
- Countersigning, hash-chaining, off-site retention and the auditor-facing
  export belong to the control plane.

## Why the line is drawn at attestation and not somewhere easier

A competent engineer can deploy the open product in an afternoon. That is fine
and expected. It does not follow that their organisation can *govern* it at
scale, and the difference is where the durable value sits.

A fork can replay its own logs. It cannot produce a record a third party will
accept, because acceptance does not come from the file format — it comes from
somebody who signs a contract about retention, operates the store, answers the
security questionnaire, and is nameable when an auditor asks who is responsible.
A fork can copy every line of code and still not supply any of that.

This is the only boundary considered that a fork cannot erase by copying. Every
alternative — feature flags, closed formats, artificial limits — is either
trivially removable or hostile to the users who make the project work.

## Consequences

**Accepted:**

- A third repository to maintain, and one more sync path to keep honest. The
  vendoring discipline this repo already documents now applies twice.
- The control plane cannot reuse `patchwork-multitenant`'s dashboard directly
  without care about which side of the boundary code lands on.
- BSL converts to an open licence after its term. That is a deliberate choice
  over fully proprietary: it keeps the community relationship legible, at the
  cost of a time-limited rather than permanent exclusivity.

**Required, effective immediately:**

- **No new governance feature lands in `patchwork-multitenant`.** Its scope is
  frozen to infrastructure. This is the operative half of this ADR — the rest is
  reasoning, and this is the rule that prevents the default from reasserting
  itself. It is recorded in `CLAUDE.md` so a future session does not have to
  rediscover it.
- Anything organisation-scoped — identity, policy inheritance, retention,
  attestation — belongs in `patchwork-control-plane`, even when it would be
  faster to put it elsewhere, and even before that repo has much in it.
- Evidence emission stays here and stays open. If a change would make the local
  logs less useful standalone in order to push someone toward the paid product,
  it is the wrong change.

**Explicitly not decided here:** anything about pricing, packaging or tiers.
Those are commercial artifacts and do not belong in this repository in any form.

## Alternatives rejected

**Build the workspace inside `patchwork-multitenant`.** Fastest path to a
running system, and it ships the commercial layer MIT. Rejected on that basis
alone.

**Relicense `patchwork-multitenant` and build there.** Avoids a third repo, but
every published commit stays MIT forever, and it is the tenant image build — in
practice this forces a fork anyway, having first spent the community goodwill.

**Keep everything MIT and monetise only hosting.** Honest and simple, but the
monetisation analysis on file is persuasive that hosting convenience alone is
thin: it is worth what the customer's own ops time is worth, and it decays as
deployment tooling improves. Attestation does not decay that way.

**Feature-flag the commercial features inside this repo.** A flag in an MIT repo
is a `git revert` away from free, and it invites exactly the resentment that
taking features away would cause.
