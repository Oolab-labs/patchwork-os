# ADR-0027: Tamper-evident ledgers — an integrity chain behind the `rv` sentinel

- **Status:** Accepted
- **Date:** 2026-09-02
- **Related:** ADR-0007 (cross-process log locking), ADR-0019 (open-core boundary),
  ADR-0025 (evidence spine), ADR-0026 (governed profile)

## Context

Phase 0 (ADR-0026) turned the boundary on. The evidence it produces is now the
thing an outside party will ask to see, and today that evidence is a set of
append-only JSONL files that any process with the operator's uid can edit,
truncate or reorder without leaving a trace. Three specific weaknesses:

1. **Six writers append with no lock.** `boundary_receipts.jsonl`,
   `privacy_shadow.jsonl`, `outcome-log.jsonl`, `butler/outcome_shadow.jsonl`,
   `run_steps.jsonl` and `pr_outcomes.jsonl` call `appendFileSync` bare. Two
   bridges sharing one `$PATCHWORK_HOME` (the reference machine runs two) can
   interleave bytes inside one row; the torn line then fails `JSON.parse` and is
   skipped by every reader. That is a row lost with no evidence it was lost.
2. **A failed append and "nobody recorded this" are the same bytes on disk.**
   Every observability writer swallows its own errors by design (an unwritable
   ledger must never abort the action it observes). The design is right; the
   consequence is that a ledger that silently stopped writing for a day is
   indistinguishable from a quiet day.
3. **Rotation destroys rows without a marker.** `worker_gate_decisions.jsonl`
   and `run_steps.jsonl` rewrite themselves when they cross a byte cap. A file
   that lost 400 rows to rotation and a file someone deleted 400 rows from are
   identical, and ADR-0025 already records that coverage measures over a
   rotated file converge toward 1.0 *by deletion*.

ADR-0025 listed per-row hash chaining as open, with the reason it was
deferred: the `rv` sentinel had to exist first, so that rows written before the
chain could never be mistaken for rows that should carry it. The sentinel has
now shipped on three ledgers (#1519, #1522, #1566) and is the mechanism this
ADR builds on.

## Decision

### One wire format, three new row shapes, no repurposed field

Integrity fields are ADDED behind a per-ledger `rv` bump. `seq` is not reused:
on the receipt and gate ledgers it is a per-PROCESS counter (ADR-0025's
"`taskId`, never `seq`" exists because of it) and cannot be monotonic across two
bridges. `rv` is not reused: it is a schema level, and a level is not a
position.

Every chained row carries:

| field | meaning |
|---|---|
| `iseq` | integrity sequence, per ledger, 1-based, monotonic across every writer of the file |
| `prev` | hex SHA-256 of the exact bytes of the previous line in the file (no trailing newline) |
| `writeFailed` | present only when appends failed since the previous row: how many (see below) |

Two marker rows live in the same file. They carry `kind` and NO `seq`, which
is what keeps every existing reader from mistaking them for data: the gate
loader requires `seq`+`workerId`+`toolName`+`action`, the receipt loader
requires numeric `seq`, the approval loader ignores unknown `kind`s.

- `{ kind: "chain-start", at, legacyRows, legacyBytes, legacyHash }` — written
  ONCE, the first time a chained append meets a file that has no chain. It
  commits to the exact bytes that precede it (`legacyHash` = SHA-256 of the
  prefix). **Legacy rows are byte-identical afterwards and are never
  re-stamped**: the marker makes the prefix verifiable from the migration
  boundary without backfilling anything, which is ADR-0025's rule applied
  rather than bent. The first chained row's `prev` is the hash of the marker
  line.
- `{ kind: "rotation", at, droppedRows, droppedLegacyRows, lastDroppedHash,
  firstKeptIseq }` — written as the new FIRST line whenever rotation removes
  rows. It re-anchors the chain: the first kept chained row's `prev` must equal
  `lastDroppedHash`, so a verifier can tell "rows were removed by rotation,
  and here is how many" from "rows were removed". A rotation that drops the
  chain-start marker leaves the legacy prefix UNVERIFIABLE, and the verifier
  says so in those words rather than reporting it verified or broken.

### One append primitive, used by every spine writer

`appendChained(file, row)` in `src/ledgerChain.ts` is the only code path that
writes a chained row. In order, all under `withFileLockSync`:

1. rotate if the file is over its byte or line cap, writing the rotation marker;
2. read the tail: the last line's hash and `iseq` (or write `chain-start` if
   there is no chain yet);
3. stamp `iseq`, `prev`, and `writeFailed` if the sidecar counter is non-zero;
4. append; update the `<file>.head` sidecar (`{ iseq, hash }`); clear the
   failure counter.

The tail read is what makes the chain correct with two bridges: the in-memory
counters each process keeps are per-process and cannot serve. The head sidecar
is what makes a **truncated tail** detectable — deleting the last N rows leaves
an internally valid chain, and only something outside the file can say the file
used to be longer.

A failed append does not throw past the writer's existing contract. It is
counted in `<file>.write_failed` (one line per failure, `{at, code}`, no
payload), and the NEXT successful row seals the count into the chain as
`writeFailed: N`. Until that row lands the count is reported as PENDING by
`patchwork evidence`, so a ledger that stopped writing is visible as such
rather than as a quiet day.

### Proven vertically on two ledgers first

This ADR lands on `boundary_receipts.jsonl` (an unlocked writer with no
rotation) and `worker_gate_decisions.jsonl` (a locked writer WITH rotation).
Between them they exercise every branch of the primitive. The remaining four
unlocked writers and `approval_log.jsonl` follow one ledger per PR, each with
its own `rv` bump and doc comment, because the reader-whitelist trap (#1517,
#1522) has to be checked per reader and is not automatable.

### `patchwork evidence verify`

An offline reader over the same files: per ledger, legacy prefix
(`verified` / `mismatch` / `unverifiable-rotated` / `none`), chained rows,
rotations seen, breaks (`hash`, `gap`, `duplicate`, `order`, `truncated`,
`malformed-marker`, each with its line number and `iseq`), sealed and pending
write failures, and the head sidecar state. It exits **1 on any break** and the
`--json` form carries `ok: false` with the break list, so a cron job can act on
it. Like `patchwork evidence` it prints counts and positions only, never a
value: a line number is not operator data, a row is.

## What this deliberately does NOT do

- **No signing.** A hash chain proves the file is internally consistent with
  what its writers wrote; it cannot prove who wrote it. Attestation and key
  custody are control-plane concerns (ADR-0019) and no key material enters this
  repository. An adversary with the operator's uid can rewrite the whole chain
  and both sidecars; what they cannot do is edit one row and leave the rest
  standing, which is the threat this addresses.
- **No backfill, no re-stamp.** Rows before `chain-start` stay as they are and
  are committed to as a block. Doctrine from `workerGateDecisionLog.ts`.
- **Not `runs.jsonl`.** Eight construction sites, several writers and its own
  archive rotation; out of scope for this slice and not on `SPINE_LEDGERS`.
- **`patchwork evidence` still exits 0.** It is a report. Only `verify` gates.

## Consequences

- Each chained ledger's `rv` rises by one; at that level a row without `iseq`
  and `prev` is a writer defect, not a state.
- Two bridges appending to one file now serialise on the lock for every spine
  ledger, not just the three ADR-0007 covered. At the bridge's write volume
  contention is unmeasurable; the timeout is the existing 5 s.
- A reader that enumerates fields explicitly (the receipt `view()`) drops
  `iseq`/`prev` on read unless extended. The verifier reads raw lines and does
  not depend on it, but the round-trip test that guards `correlationId` is
  extended to the new fields so the drop is at least visible.
