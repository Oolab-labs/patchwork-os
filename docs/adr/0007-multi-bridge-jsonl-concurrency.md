# ADR-0007: Multi-Bridge JSONL Concurrency

**Status:** Proposed
**Date:** 2026-04-18

## Context

Three append-only JSONL logs back the Patchwork context platform:

- `decision_traces.jsonl` — `src/decisionTraceLog.ts`
- `commit_issue_links.jsonl` — `src/commitIssueLinkLog.ts`
- `recipe_runs.jsonl` — `src/runLog.ts`

All three share the same implementation shape:

1. **Load once at startup** via `loadExisting()` — reads the file into an in-memory array, seeds `this.seq` from the max `seq` observed.
2. **Append on write** via `appendFileSync(...)`.
3. **Serve reads from memory** via `query()`.

This is safe for a single bridge process. It is **not** safe when two or more bridges share the same `~/.claude/ide/` (or otherwise coincident log directory) — which is the realistic deployment when a developer runs one bridge per workspace against a common `$HOME`.

### The bug

Bridge **A** and bridge **B** both start, each calling `loadExisting()` once. Thereafter:

- Bridge A writes trace `seq=101`. File grows. A's memory grows.
- Bridge B writes trace `seq=101` (its own counter, also seeded from the same file snapshot). File grows — **now has two rows with `seq=101`**. B's memory does not include A's row.
- Queries against A miss every B-originated trace until A restarts. Symmetric on B.
- Seq collisions are silently tolerated (`query()` sorts by seq desc, doesn't dedupe).

The blast radius is bounded (nothing crashes; dashboards simply show stale/partial data) but it quietly undermines the "durable cross-session memory" promise that the context platform is built on.

### Why it was deferred

Phase 2 shipped (PR #6) with the single-bridge assumption baked in. The multi-bridge case is real but not in any shipped user flow yet, and the fix is non-trivial enough that we want to agree on direction before writing code. Hence this ADR rather than a patch.

## Options considered

### Option A — Tail-on-read

Before every `query()`, `fstat` the file. If size grew since last load, read the delta and merge. Keep the in-memory ring as a cache.

- **Pro:** Minimal change. No cross-process coordination needed.
- **Pro:** Naturally handles N writers.
- **Con:** Every query does a syscall + possible parse of new rows. Cheap in absolute terms (JSONL, bounded growth) but no longer O(1) in memory.
- **Con:** Still need a dedupe strategy for `seq` collisions — or switch the id scheme.

### Option B — Per-bridge log files

Each bridge writes to `decision_traces.<pid>.jsonl`. Readers glob-merge at query time.

- **Pro:** Zero write contention. No seq collisions (scope seq per file).
- **Con:** Query path fans out across N files. Orphan files from crashed bridges accumulate.
- **Con:** Breaks the "one log, one source of truth" mental model the dashboard currently relies on.

### Option C — Move to SQLite

Replace JSONL with a shared SQLite database (WAL mode handles multi-writer cleanly).

- **Pro:** Correct by construction. Indexing. Transactional.
- **Con:** New dependency. Migration story for existing JSONL files. Larger change than the problem warrants today.
- **Defer:** Revisit when/if the context platform graduates beyond single-host.

### Option D — File lock + reload-on-write

Advisory lock (`proper-lockfile` or `flock`) around every append; reload the whole file before every query.

- **Pro:** Simple correctness.
- **Con:** Reload-whole-file defeats the in-memory ring. Lock contention scales poorly with writers.

## Decision

**Adopt Option A (tail-on-read)**, with a seq-scheme change to eliminate collisions:

1. **ID scheme:** replace integer `seq` with a composite `{ writerId, localSeq }` where `writerId` is a per-process UUID (stable for bridge lifetime) and `localSeq` is the current monotonic counter. Serialize as `seq: "<writerId>:<localSeq>"` or split into two fields — bikeshed in implementation PR. Existing numeric rows are grandfathered: reader treats a bare number as `{ writerId: "legacy", localSeq: n }`.
2. **Tail-on-read:** each log tracks `lastReadOffset: number` (file byte offset). `query()` first calls `fstat`; if `size > lastReadOffset`, reads `[lastReadOffset, size)`, parses new rows, merges into the in-memory ring (respecting `memoryCap`), advances `lastReadOffset`.
3. **Memory ring unchanged:** still bounded by `memoryCap`. Tail reads evict oldest entries as needed.
4. **Writes unchanged:** still `appendFileSync`. POSIX guarantees atomic appends for writes ≤ `PIPE_BUF` (4KB on Linux/macOS), which covers every realistic trace row.

The tail-on-read cost is one `fstat` per query plus occasional small reads. For the query volume we see (dashboard polls, session-start digest), this is well under 1ms amortized.

## Non-goals

- **Cross-host sharing.** If/when the context platform goes networked, revisit Option C.
- **Perfect ordering across bridges.** `createdAt` (ms epoch) is the ordering key the dashboard already uses; seq is pagination-only. Clock skew between bridges on the same host is bounded enough to not matter for a human-readable feed.
- **Rewriting legacy rows.** Existing `seq: number` entries stay as-is.

## Migration

- Ship in one release. No config flag. All three logs migrate together so the reader path has a single shape to handle.
- Before-rollout test: start two bridge processes pointing at the same `--log-dir`, issue writes and queries against both, assert each sees the other's rows within one query.

## Follow-ups

- Unit test harness for the two-writer case (`src/__tests__/multiWriter.test.ts` — spawn two `DecisionTraceLog` instances on the same dir, interleave writes and queries).
- Dashboard: audit any code path that compares traces by numeric `seq` (sort, pagination cursors). The composite id must round-trip through the HTTP API.
- Delete this ADR's "Proposed" tag once the PR lands.
