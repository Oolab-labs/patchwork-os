# ADR-0020: Per-Member Authentication — A Subject, Before Anything Can Be Attributed

**Status:** Accepted
**Date:** 2026-08-04
**Unblocks:** [ADR-0017](0017-decision-record-actor-and-forbid.md) (actor
attribution), [ADR-0018](0018-durable-approvals.md) (approval ownership),
segregation of duties in `src/identity/members.ts`.
**Bounded by:** [ADR-0019](0019-open-core-boundary.md) — Phase A is MIT and
lives here; Phase B (OIDC federation) is control-plane. See "Where Phase B is
built".

## Context

`src/identity/` exists and is careful. Six roles, a capability matrix, members
that are deactivated rather than deleted so no decision is orphaned, and a
segregation-of-duties check that runs the self-approval test *before* the
capability test — because an owner holds `action.approve`, so testing capability
first would report an owner approving their own work as allowed.

`canApproveAction` is referenced by its own module and its own tests. Nothing
else in the tree calls it.

It cannot be called, because nothing that reaches the bridge says who is acting:

- The bridge authenticates **one shared bearer token**, validated with
  `crypto.timingSafeEqual`. Correct, and anonymous.
- The dashboard session cookie is `v1.<expiresAtMs>.<HMAC>`. Its signed payload
  is, in full, `` `v1.${expiresAt}` `` (`dashboard/src/lib/session.ts`). It
  proves someone knew `DASHBOARD_PASSWORD` before a timestamp. Nothing more.

So the roster describes real people and has no way to know which of them is
doing something. Every approver is identical at the auth layer.

The consequence is not cosmetic. ADR-0017 added an optional `actor` snapshot to
`GateDecisionRecord`; it is permanently absent, which is the correct behaviour,
because the only actor available to write would be invented. **Defaulting the
actor to the implicit owner would put a claim about a real person into an audit
record on no evidence** — worse than absence, since absence already means
"nobody recorded this" and is never backfilled.

Durability was the other suspected blocker and is resolved: ADR-0018 shipped
(#1245, #1246), and risk-tiered timeouts landed in #1214. Identity is what
remains.

## Decision

**Build per-member authentication behind a pluggable seam that resolves to the
existing `members.json` roster. Local credentials first; OIDC second.**

### The seam

One interface, two implementations, resolving to a `Member` from the roster:

```
authenticate(request) -> Principal { memberId, ... } | null
```

Everything downstream — decision records, approvals, SoD — depends only on the
seam, never on how the principal was established. This is load-bearing rather
than tidy: a single-user laptop, a hosted workspace and an enterprise with an
IdP have genuinely different answers, and any design that assumes one of them
has to be unpicked to support the others.

The seam resolves to `members.json`, which already honours `PATCHWORK_HOME` and
already fails soft to one implicit owner. That fail-soft behaviour is preserved
exactly (see Consequences).

### Phase A — local credentials

Per-member passwords, verified against a hash stored beside the member record.

**`crypto.scrypt`, from the Node standard library.** The dependency audit is
unambiguous: this repo has no bcrypt, argon2, passport, next-auth or jose
dependency, direct or dev. Adding a native-compilation password-hashing
dependency to a project that installs globally on macOS, Linux and Windows —
and which already documents a macOS TCC symlink footgun around global installs —
buys a marginally better KDF for a real cross-platform install risk. `scrypt` is
memory-hard, in the standard library, and available in every runtime the bridge
already targets.

The dashboard session payload extends to carry the subject. It must be a new
cookie version (`v2.<memberId>.<expiresAt>.<HMAC>` or equivalent) — a v1 cookie
must not be readable as an unattributed v2, or the absence of a subject becomes
a *claim* of one, which is the failure this ADR exists to prevent.

### Phase B — OIDC

**Map on `sub`, never on `email`.** Email addresses are reassigned; `sub` is
stable per issuer. A record naming a person is only as trustworthy as the
identifier it was keyed on, and keying on a mutable field means a future
employee can inherit a predecessor's audit history.

Phase B adds an implementation behind the same seam. It does not change any
consumer.

### Where Phase B is built — the open-core boundary

This ADR and [ADR-0019](0019-open-core-boundary.md) were written in the same
commit and this one never cited that one, which left a collision nobody had
looked at.

ADR-0019 reserves **organisation identity (SSO/SCIM)** for the non-MIT
`patchwork-control-plane`, on the reasoning that governance features would
otherwise ship MIT *by default* — simply by being built where they naturally
belong — and that a published MIT commit cannot be withdrawn. OIDC federation
against a company's identity provider is that category, not a near neighbour of
it. Read together and unamended, the two ADRs said: build the thing ADR-0019
reserves, here, under MIT.

So, explicitly:

| Part | Where | Licence |
|---|---|---|
| The seam itself — the resolver interface, `UNATTRIBUTED`, the fail-soft roster default | this repo | MIT |
| **Phase A** — local `crypto.scrypt` credentials for a single workspace | this repo | MIT |
| **Phase B** — OIDC mapped on `sub` against an organisation's IdP | `patchwork-control-plane` | non-MIT |

**The seam is the correct MIT artifact, and it is the valuable half of the
design.** A self-hoster gets real per-member authentication from Phase A, every
consumer of an identity keeps working unchanged, and nothing here depends on
the control plane existing. What sits behind the seam for an *organisation* —
federation, directory sync, the mapping to a corporate subject — is what
ADR-0019 draws the line around.

This is a boundary decision, not a schedule. Phase B may be built whenever it
is worth building; the constraint is only that it is built in the repository
whose licence matches what it is.

**The nearby thing that is NOT reserved:** `src/identity/` as it stands today —
roles, a local `members.json`, `canApproveAction` — is runtime, and ADR-0019's
MIT column names "local approvals, the single-workspace gate" outright. It
reads one local file, has no notion of a tenant or a directory, and fails soft
to a single implicit owner. It stays here. The line is federation, not identity.

## Consequences

**The fail-soft default is preserved, deliberately.** A missing, unreadable or
malformed `members.json` still degrades to one implicit owner, byte-identical to
pre-identity behaviour. This is the opposite of ADR-0016's fail-closed gate, and
the asymmetry is intentional: that gate decides *whether an action happens*, so
the safe default is no; this decides *who you are on your own machine*, so the
safe default is the status quo ante. Authentication that fails closed on a
laptop would break every existing single-user install to solve a problem those
installs do not have.

**An unauthenticated principal stays unattributed.** When the seam returns null,
the actor field remains absent. It does not fall back to the owner. This must
hold at every write path — the bridge, the dashboard, the tenant image — and is
exactly the multi-site consistency failure mode that has already produced three
bugs in this subsystem. Prefer deriving the principal at the point of use over
threading it through call sites that can forget.

**Deactivation, not deletion, extends to credentials.** A deactivated member
keeps their record and history and can no longer authenticate. Deleting the
credential must not delete the member.

**The shared bearer token does not go away.** It remains how a machine client
(the CLI, a recipe runner) authenticates. Per-member identity is about humans
taking consequential decisions, and conflating the two would either break
automation or hand automation a human's name.

**Ordering.** Nothing in Phase 2 of
the workspace scope (`governed-workspace-scope.md`, removed from this repository as commercial material) — attributed records, SoD
enforcement, approval routing, signed export — should start before Phase A
lands. Each is finished by identity and unfalsifiable without it.

## Alternatives rejected

**Per-member bearer tokens only.** The smallest change: give each member their
own token instead of one shared one. Rejected because a bearer token is a secret
that gets pasted into config files, shared between colleagues and committed by
accident. It answers "which token was used", which an auditor will not accept as
"who approved this" — and the whole point of the exercise is producing a record
somebody else believes.

**OIDC only, skipping local credentials.** Strongest evidence story and closest
to what enterprise buyers ask for, but it blocks all attribution until an IdP
exists. Single-user and small-team installs — the current installed base — would
keep an absent actor indefinitely, so the feature could never be dogfooded on
the workspace it was built in.

**Delegating to consumer OAuth (GitHub / Google) instead of owning credentials.**
The strongest alternative, and materially different from the enterprise-IdP
option above: it needs no IdP to be stood up, and it avoids owning password
reset — a real and recurring cost for a very small team, and a place where
home-grown auth usually goes wrong.

Rejected on one architectural ground: it makes authentication depend on a
network round-trip to a third party. The free product's central property is that
it runs locally, offline, on a laptop, and an operator who cannot authenticate
because GitHub is unreachable cannot approve anything — turning an outage at an
unrelated company into a work stoppage governed by our gate. It also puts a
third party in the evidence path for records whose whole purpose is to be
defensible.

The cost is acknowledged rather than dismissed: owning credentials means owning
reset, lockout and rotation. Two things reduce it. Password reset for a roster
measured in single digits is a CLI command, not a flow. And because both are
implementations behind the same seam, delegating to GitHub/Google can be added
later as a *third* provider without disturbing any consumer — mapped on the
provider's `sub`, exactly as Phase B is.

**Defaulting the actor to the implicit owner.** Rejected outright, and recorded
here so it is not re-proposed as a shortcut. It fabricates evidence.
