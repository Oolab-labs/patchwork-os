# ADR-0023: The Hosted Tenant Consumes the Published Package, Not a Forked `src/`

**Status:** Accepted
**Date:** 2026-08-21

## Context

`patchwork-multitenant` builds its tenant image from its **own** copy of this
repository's `src/`. `Dockerfile:23` is:

```
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev
```

`CLAUDE.md` described that copy as *verbatim*, kept in file-for-file sync, with
every bridge-side change "made here first, then snapshotted". That description
was accurate when written and is no longer true. Measured 2026-08-21:

| | count |
|---|---|
| shared files that differ | 145 |
| paths only in this repo | 114 |
| paths only in the fork | 15 |
| `.ts` files (here vs there) | 1310 vs 1192 |

Absent from the fork **entirely**: `src/identity/`, `src/privacy/`,
`src/runStore/`, `src/butler/`, `src/workspaceId.ts`,
`src/approvalPersistence.ts`, `src/workers/{forbidPolicy,previewActions}.ts`.

The fork's last recorded content sync is a commit dated **2026-06-08**
("pull 21 patchwork-os commits into bridge src/"). Nothing since has synced
content; the only later commit touching `src/` there is a lint pass.

Two consequences, and the second is the one that matters:

1. **A fix landed in this repo reaches zero hosted tenants.** Every governance
   feature built here since June — per-member authentication, the information
   boundary, the workspace tag, durable approvals, forbid rules, the control
   boundary preview — is absent from the tree the tenant image compiles. A
   hosted deployment's governance panels would not be wrong; they would be
   **structurally empty**, which reads identically to "nothing happened".

2. **Nothing notices.** There is no gate, in either repo, that compares the two
   trees. The sync was a manual habit, and habits decay silently. This is this
   project's own recurring defect family — a correct rule pointed at a partial
   surface — at repository scale.

## Options considered

**A. Keep forking, add a loud drift gate.** Cheapest to build and it makes the
problem visible. It does not make the problem *smaller*: a human still has to
hand-merge 145 files, and nothing forces them to. A gate that reports drift
every run, that nobody can clear in an afternoon, becomes the noise this repo
has repeatedly identified as how a real warning gets ignored. Rejected as a
destination; retained as a **transitional** measure (see below).

**B. Carve the runtime into a new private npm package both repos consume.**
Architecturally right and unnecessary: it duplicates work already done.

**C. Collapse the fork onto the package that already exists.** `patchwork-os`
is published — `latest` and `beta` at `1.2.0-beta.2`, `canary` tracking main.
The tenant image does not need a vendored `src/` at all; it needs a *pinned
version* of a published artifact. `COPY src/` + `npm run build` becomes a
dependency line.

## Decision

**Option C.** The hosted tenant image consumes `patchwork-os` from npm at a
pinned version. The fork's `src/` is deleted, not maintained.

The cost is not 1310 files. It is the small set of things the fork genuinely
*added* rather than merely aged past — tenant-specific HTTP routes and one
worker helper. Each is resolved one of three ways, in this order of preference:

1. **Upstream it here**, tenant-agnostic, behind a flag if it must be inert by
   default. Preferred: it is the only outcome that leaves one implementation.
2. **Make it a plugin.** The plugin system already registers additional tools
   in-process (`--plugin <path>`), so anything tool-shaped belongs there.
   Route-shaped additions do not fit today; extending the plugin contract to
   cover them is in scope for this migration if a route genuinely cannot be
   upstreamed.
3. **Keep it in the fork as a thin layer over the dependency** — a file that
   imports the package and adds to it, never a modified copy of a package file.
   A layer can be reviewed; a 145-file divergence cannot.

Rule that outlives the migration: **the fork may add files, never edit
package files.** The moment it edits one, it is a fork again and this ADR has
been abandoned rather than superseded.

### Transitional gate

Until the migration lands, a drift check runs and is **loud on purpose**. It is
acceptable for it to be noisy precisely because it is temporary — its noise is
the schedule pressure. It must be deleted, not silenced, when `COPY src/` goes.
A drift gate that outlives the fork it was measuring is a check that can no
longer fail.

## Consequences

- **Hosted governance becomes real.** The tenant image gains the identity,
  privacy, workspace-tag, durable-approval and control-boundary code by virtue
  of installing a version that has them, rather than by anyone remembering.
- **Version becomes explicit.** A pinned dependency states which runtime a
  tenant runs. Today the answer is "whatever was copied in June", and it is not
  written down anywhere — it had to be *measured* to write this ADR.
- **The npm packaging gate starts protecting the hosted product too.** This
  repo's `package.json` `files` field excludes several modules from the tarball;
  a Docker build that compiles `src/` directly honours none of that, because
  `files` governs npm packaging and nothing else. Installing the package instead
  of compiling the tree makes those exclusions load-bearing where today they are
  bypassed. This is the strongest single argument for Option C and was not the
  reason it was chosen — it was found while writing this down.
- **Upgrading a tenant becomes a version bump**, with the ordinary consequence
  that a bad version reaches every tenant at once. Pinning, not floating on
  `canary`, is therefore part of the decision rather than a detail of it.
- **ADR-0019 is unaffected.** Nothing here moves a governance feature into an
  MIT repo. It moves a *build input*: the fork stops carrying a copy of MIT code
  and starts depending on it. The open-core line is where features are built,
  not how a container obtains a runtime.

## What this ADR does not decide

Whether the fork repository stays private, what its own licence should cover,
and how tenant-local additions are reviewed. Those are separate and at least one
of them is an operational matter recorded outside any repository.
