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

**Adopt Option A (tail-on-read).** Keep `seq` as a per-process integer — no composite-id schema change. Add an advisory lock around each append so tearing isn't a correctness concern.

1. **Tail-on-read:** each log tracks `lastReadOffset: number` (file byte offset). `query()` first calls `statSync(file)`; if `size > lastReadOffset`, reads `[lastReadOffset, size)`, parses new rows, merges into the in-memory ring (respecting `memoryCap`), advances `lastReadOffset` and `this.seq`. Reuses the existing parse/validate block from `loadExisting` — factor into `parseLine()`.
2. **`seq` stays per-process, non-unique across writers.** A codebase audit ([docs/adr-0007-research.md] — see PR thread) confirms no consumer requires uniqueness: seq is used only as a pagination cursor and sort key. Pagination cursor becomes a `(createdAt, seq)` tuple so ties are broken deterministically. React keys in the dashboard already use `taskId` / `(ts, key)` tuples, not seq. No schema change on the wire; the `after` query param gains a companion `afterTs`.
3. **Sort order:** `ORDER BY createdAt DESC, seq DESC`. Both in-memory (`sort`) and in the dashboard.
4. **Append atomicity:** POSIX does **not** guarantee non-interleaved concurrent appends to regular files. Linux ext4/xfs holds the inode mutex for sub-page writes in practice (not a contract). macOS APFS has been empirically shown to tear at ~256 bytes — well below our typical row size. Therefore: wrap each append in `proper-lockfile` (or `fs.flockSync` via a native binding) around a short critical section: `open(O_APPEND) → flock(LOCK_EX) → write → flock(LOCK_UN) → close`. Lock contention at our write volume (≤ tens/min) is negligible. Readers remain lock-free — torn rows would fail `JSON.parse` and be skipped, but locking eliminates that failure mode entirely.
5. **Memory ring unchanged:** still bounded by `memoryCap`. Tail reads evict oldest entries as needed.

The tail-on-read cost is one `statSync` per query plus occasional small reads. For the query volume we see (dashboard polls, session-start digest), this is well under 1ms amortized.

## When to revisit (trigger for Option C / SQLite)

Tail-on-read is the right answer *now* at current scale (≤1k traces/day, bounded in-memory ring). It is **not** the permanent answer. Migrate to SQLite when any of these trip:

- Any single log crosses **~50k persisted rows** (linear-scan query latency starts to matter).
- A query pattern needs a genuine **cross-log join** (e.g. "traces whose ref matches a commit that closed issue N") at the storage layer rather than the dashboard layer.
- The context platform ships a **networked** sync story (different product; different ADR).

Migrating later is strictly cheaper than migrating now: rows to convert grow linearly, but schema decisions made against observed query patterns are dramatically better than guessed ones.

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
