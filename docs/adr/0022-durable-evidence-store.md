# ADR-0022: A Durable Evidence Store for Runs and Steps

**Status:** Accepted
**Date:** 2026-08-13
**Bounded by:** [ADR-0019](0019-open-core-boundary.md) — the store is MIT and
lives here; the JSONL export path stays open-format and standalone-usable, so
nothing in this ADR moves evidence behind the control plane.
**Related:** [ADR-0018](0018-durable-approvals.md) (the same argument, applied
to approvals), [ADR-0017](0017-decision-record-actor-and-forbid.md) (decision
records), [ADR-0020](0020-per-member-authentication.md) (the no-native-dependency
precedent this ADR follows).

## Context

`~/.patchwork/runs.jsonl` is the autonomy gate's trust evidence. Every claim the
system makes about whether a worker has earned an action-class is a fold over
rows in that file. It is also an append-only text file with no integrity
properties, and in the eight weeks to 2026-08-13 it failed three separate ways,
each silently, each producing a plausible green.

- **#1324 — identity.** `seq` is a per-instance counter, but the file is shared
  by eight construction sites, several of which write. Two live instances hand
  the same `seq` to unrelated runs: 142 of 145 seqs collided in the live log.
  Deduping on it destroyed two-thirds of the run history.
- **#1340 — in-flight steps.** Only `completeRun` wrote steps, so a run that
  died mid-flight recorded none of the work it had actually done.
- **#1341 — liveness.** A concurrent *reader* marked live runs `interrupted`,
  which made `completeRun` a silent no-op. A successful run was recorded as
  `interrupted, steps: 0`.

Each was fixed. The pattern was not: a file format with no transactions, no
primary key, and no concurrency control was asked to be a system of record, and
it produced wrong answers that read as right ones. The subsequent fixes have
grown most of a database inside `runLog.ts` — now 1,089 lines carrying a file
lock, byte *and* line caps, a second archive tier with its own 8 MB cap, a
`readFromDiskBySeq` disk probe, and an upsert-by-`taskId` reconciliation path.

That reimplementation is losing. `runLog.ts:753` documents, in a comment, a
lost write we have chosen to live with:

> If `rotateDisk()` runs before the lock is acquired, a concurrent bridge can
> `appendFileSync` between the `.tmp` write and the `renameSync` — that row
> lands on the file about to be atomically replaced.

A durable store is not a performance change. It is the difference between
evidence and an anecdote.

### What is actually true today, measured

Prior write-ups cited an 18.2h retention span against the 24h durability window.
That was accurate when measured and is **not** the state today. Measured
2026-08-13 against the live log:

| Fact | Value |
|---|---|
| Live rows | 1,123 |
| Retention span | **58.8h** (window is 24h — currently sufficient) |
| File size | 851,327 bytes — **81.2% of the 1 MB rotation cap** |
| `runs.jsonl.1` (rotation archive) | **does not exist — has never been written** |
| Highest-volume recipe | one high-frequency recipe, 953 rows (**85%**) |
| `butler-errand` (the governed worker) | 26 rows (2.3%) |

This changes the argument, and the honest version is weaker but still decisive.
We are not fixing an active fire. We are 19% of a megabyte from the **first
rotation this installation has ever performed**, which will exercise
never-executed code (`readArchive`, `archiveDropped`) while deleting the oldest
evidence, at a moment when one unrelated recipe accounts for 85% of the volume
competing for that budget. The starvation is ahead of us, not behind.

## Decision

Move `runs` and `run_steps` to an embedded SQLite database behind a repository
interface. Retain JSONL as the append-only **export** path, not the store.

### 1. Driver: `node:sqlite`, with `engines` raised to `>=22.5.0`

`node:sqlite` is experimental and prints an `ExperimentalWarning`.
`better-sqlite3` is mature but compiles natively. Both carry real cost; we take
the experimental one.

**The failure modes are not symmetric.** If `node:sqlite`'s API shifts, CI goes
red on a version bump and we ship a fix — visible, contained, ours to absorb. If
`better-sqlite3` fails to compile, `npm i -g patchwork-os` fails outright for
that user, we never see it, and they cannot route around it. A broken install is
strictly worse than a broken build.

**It is the position this repo already took and wrote down.** ADR-0020 rejected
a native password-hash dependency on cross-platform install risk and chose
`crypto.scrypt`. Adding a native dependency here — for a *less* security-critical
reason — would either contradict that ADR or quietly hollow it out. If native
dependencies are in fact acceptable, the honest move is to reopen ADR-0020, not
to establish a counter-precedent in a different subsystem.

**The engines bump is close to free.** Node 22.5 shipped July 2024 and the 22.x
line is in maintenance; anyone pinned to 22.0–22.4 is already on an unpatched
security line.

Consequences accepted:

- **CI must add Node 24** to the matrix. It currently tests 22 only, so an
  experimental-API change on a newer runtime would reach users before it reached
  us. This is a requirement of the decision, not a nice-to-have.
- The `ExperimentalWarning` is suppressed **narrowly** at the import site, never
  process-wide — a global suppression would also hide warnings we want.

This decision is deliberately cheap to reverse: the driver sits behind the
repository interface, so swapping to `better-sqlite3` is one module. Reversible
decisions do not deserve more agonising than irreversible ones.

### 2. Scope: `runs` and `run_steps` together, and nothing else

A step belongs to a run. Splitting them puts a foreign-key relationship across
two storage engines with no way to make the pair atomic — a new bug class in
exchange for a smaller diff.

**A `run_steps`-only pilot was considered and rejected.** It is 13 rows and 138
lines with no rotation, no `getBySeq`, no concurrent writers and no dedup. It
would validate the plumbing while exercising **none of the properties being
bought**, and come back green having proved nothing. That is precisely the
recurring failure this project keeps catching in itself: verification that could
not have failed.

Explicitly **out of scope**:

- The other seven JSONL ledgers (`outcome-log`, `worker_gate_decisions`,
  `approval_log`, `decision_traces`, `permission_exercises`, `file_rollback`,
  `worker_trust/`). Smaller, slower-growing, not yet failing.
- Any change to what a run *means* — no schema redesign smuggled in behind a
  storage change.
- The `/runs/[seq]` URL contract. Retiring `getBySeq` in favour of `taskId` is a
  real follow-up, not a freebie.

### 3. De-risk on the time axis, not the scope axis

Rather than a cutover:

1. **Dual-write.** JSONL remains the source of truth; every write also goes to
   SQLite. Nothing reads SQLite.
2. **Shadow-read comparison.** Every read runs against both and reports
   divergence — in production, on real traffic, **through the next rotation**.
   If the two disagree about what survived, we learn it while JSONL is still
   authoritative.
3. **Flip** only after one rotation and one full trust-fold cycle have passed
   with zero divergence.
4. JSONL demotes to the append-only export path (ADR-0019's open-format
   guarantee).

`getBySeq`'s collision problem (#1360) is folded into this work rather than
fixed separately: a real primary key *is* the fix, and doing it during the
migration costs nothing extra.

### 4. The migration must be able to fail

The shadow-read comparison is the verification, and it only counts if it can go
red.

**AMENDED 2026-08-14 — the original criterion is no longer satisfiable, and
that is a finding rather than a technicality.** It read: replay #1324, #1340
and rotation loss against both stores, and *JSONL must visibly lose all three*.
Checked against the code, two of the three no longer reproduce, because we
fixed them in the meantime:

- **#1324** — `runKey()` keys on `taskId`, so JSONL resolves a `seq` collision
  at read time and loses nothing.
- **#1340** — `append()` persists to a sibling ledger and `loadStepEvidence`
  folds it back, so in-flight steps survive.

That criterion was written while those bugs were fresh and was not revisited
when the fixes landed. Demanding a loss that can no longer happen would leave
the flip permanently blocked — or invite quietly waiving the gate, which is how
a gate stops meaning anything.

**The amended gate.** One of the three still separates the stores by losing
data, and it is the one this ADR was really about:

- **Rotation.** `runs.jsonl` caps at 1 MB live plus an 8 MB archive and trims
  the OLDEST rows; they are gone from disk, not archived. Demonstrated in
  `src/runStore/__tests__/flipGate.test.ts`: a worker filing written first,
  then buried under ~10.5 MB of one noisy recipe's traffic, is absent from the
  raw bytes of BOTH files while SQLite retains all 5,001 rows. Asserted against
  the bytes rather than through a reader — a reader could omit a row for its own
  reasons; the bytes cannot — and guarded against passing vacuously on an empty
  log.

The other two are now differences in KIND, not in loss: JSONL resolves a
collision when reading, SQLite refuses it when writing. Prevention beats
resolution — a constraint cannot be forgotten by a future reader — but it is
not evidence loss, and the gate does not claim it is.

**Also required before the flip, unchanged:** shadow-read comparison against
real traffic showing no divergence, through at least one rotation.

## Consequences

**Good.** Atomic writes across concurrent bridges; a real primary key; retention
that can be expressed as a policy rather than a byte cap fighting a time window;
`runLog.ts` shrinks toward a repository rather than growing another tier.

**Bad.** A larger change than a swap, most of it verification rather than
storage code. An experimental Node API in the trust path. A dropped tail of Node
22.x users. `~/.patchwork` gains a binary file — mitigated by JSONL export
remaining first-class, which ADR-0019 requires anyway.

**Unresolved.** Whether the other seven ledgers follow. They should not move
until this one has survived a rotation in production; migrating all of them on
an unproven interface would risk a silent evidence gap in eight places at once —
the exact failure this subsystem exists to prevent.
