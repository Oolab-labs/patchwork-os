# Speculative Multi-File Refactoring

> Stage edits, review the diff, run tests, then commit — or discard. The pre-commit phase is fully reversible. The commit phase is not. This doc is honest about both.

Most agentic refactoring tools edit files directly. Patchwork ships a transaction surface — `beginTransaction`, `stageEdit`, `commitTransaction`, `rollbackTransaction` — that lets you stage a multi-file change in memory, inspect the full diff, run any verification you want, and *only then* write to disk. If anything looks off, `rollbackTransaction` discards the staged state and nothing on disk has changed.

This is the workflow most people actually want when an AI proposes a 40-file refactor.

---

## What's safe and what isn't

The honest version, which the [Positioning agent's report](strategic/2026-05-02/positioning-report.md) section 9 explicitly flagged should not be oversold.

| Phase | Safe? | What can go wrong |
|---|---|---|
| **Stage → review → discard** (the loop you'll use 90% of the time) | ✅ Fully safe | Nothing — staged edits live in memory, never touch disk |
| **Stage → review → tests → commit** (when tests pass before commit) | ✅ Functionally safe | If commit succeeds, your tests already verified the staged content |
| **Mid-commit failure** (commit succeeds for some files, fails for others) | ⚠️ **Not atomic** | Files written before the error stay written; you'll need git to recover |

The third row is the load-bearing caveat: [`commitTransaction`](../src/tools/transaction.ts) writes files in a sequential loop. If the 4th file's write fails (permission denied, disk full, NFS hiccup), files 1-3 are already on disk and stay there. The tool's own schema description states this; the docs should too.

What this means in practice: **the transaction system is a checkpoint mechanism, not a database transaction.** Use it to gate "did I really mean this?" decisions, not to guarantee post-commit recovery.

---

## When to use this

**Strong fit:**

- An AI just proposed a multi-file refactor and you want to see all the diffs in one place before any of them land.
- You want to run tests against the staged state before committing — yes, this is supported (see below).
- You're doing a speculative experiment — *"show me what `await foo()` → `foo().pipe(retry(3))` would look like across this module"* — and want zero-cost discard.
- You want a single approval-gate moment (the commit) for what would otherwise be 40 individual edit gates.

**Weak fit:**

- You need post-commit atomic guarantees. Use git for that — commit, run, revert if needed.
- Your edits target untracked files (the recovery path is git, so files outside the repo lose their previous content on a partial-commit failure with nothing to revert to).
- You want long-lived transactions. The TTL is 30 minutes; transactions older than that are reaped.

---

## The five-step loop

```
beginTransaction()           → returns transactionId, expires in 30 min
stageEdit(txId, file, ...)   → repeated for each file; pure in-memory
[review the diff yourself]
[optionally run tests against the workspace as it would look — see below]
commitTransaction(txId)      → atomic in intent, sequential in implementation
        OR
rollbackTransaction(txId)    → discards staged state, nothing on disk changed
```

### Reviewing the diff before commit

`stageEdit` returns the proposed `newContent` plus the file's existing `oldContent`. Glue them into your tool of choice:

```ts
const tx = await beginTransaction();
await stageEdit(tx.transactionId, "src/foo.ts", { newContent: "…" });
await stageEdit(tx.transactionId, "src/bar.ts", { newContent: "…" });
// At this point, getTransaction(tx.transactionId) returns the full edit list.
// Render the diffs in the dashboard, in your IDE, or via `git diff` against
// the on-disk version — your choice.
```

The dashboard's `/transactions` page (when running `patchwork start-all`) shows active transactions, staged file count, time-to-expire, and a per-file diff hover.

### Running tests against staged state

Two patterns work:

**Pattern A: write-test-rollback-or-commit.** Commit, run tests, rollback via git if they fail. Simpler but uses git as the safety net, which is fine if everything's tracked.

**Pattern B: shadow workspace.** Write the staged content to a parallel directory, run tests there, then `commitTransaction` only if green. More work; gives you tests-against-staged without touching the real workspace.

Pattern A is what most agentic workflows use. Pattern B is for edits to untracked files or for very-large refactors where rollback noise matters.

---

## Worked example: agent-driven refactor

```
You:    "Rename `runTask` to `runTaskInternal` everywhere it's used internally,
         keep the public name as a thin wrapper."

Claude: [Calls findReferences for runTask]
        [Calls beginTransaction → tx_abc]
        [For each call site: stageEdit(tx_abc, file, newContent: rewritten)]
        [Final stageEdit creates the wrapper export]

You:    [Open dashboard /transactions, see 23 staged files, scroll the diffs]

You:    "Looks good but you missed the JSDoc — re-stage src/foo.ts with
         the @deprecated annotation"

Claude: [stageEdit(tx_abc, src/foo.ts, ...)]  ← overwrites prior staged version

You:    "OK, commit it. I'll run tests after."

Claude: [commitTransaction(tx_abc) → all 23 files written]

You:    [npm test → passes]
You:    [git diff → 23 files, the rename you wanted, nothing else]
```

If tests had failed: `git reset --hard HEAD` reverts everything (because the prior state was a clean working tree). The transaction system isn't doing that recovery — git is. Use the transaction to gate the *moment* of commit; use git to recover from the *outcome* of commit.

---

## Constraints worth knowing before you start

- **30-minute TTL.** Transactions older than 30 min are reaped on the next stage/commit attempt. Long deliberation cycles need re-staging.
- **Single workspace per transaction.** All files in a transaction must live under the workspace path passed to `createTransactionTools`. Edits outside the workspace are rejected.
- **No nested transactions.** A transaction holds no lock — two concurrent transactions can stage the same file. Last-commit-wins on the file. If your workflow has multiple concurrent agents, scope transactions to non-overlapping file sets.
- **Commit re-write, not patch.** `stageEdit` takes `newContent` (full file), not a diff. The tool spec gives you `oldContent` if you want to compute the diff yourself, but the staged form is full text.
- **No file create / delete via the transaction.** `stageEdit` writes existing files. Creating a new file or deleting one requires Write/Bash outside the transaction surface — those are not gated by the transaction.

---

## What this is *not*

To be clear about what the agentic-refactoring marketing claim does and doesn't say:

- ✅ "Stage edits, review the diff, then commit or discard." — TRUE
- ✅ "The pre-commit phase is fully reversible." — TRUE
- ✅ "Tests can run against staged content before commit." — TRUE (with pattern B above; pattern A uses git)
- ❌ "Commits are atomic — partial failures roll back automatically." — **FALSE.** This is the line the Positioning agent flagged.
- ❌ "The transaction system is a database transaction." — FALSE; it's a checkpoint, not a persistence guarantee.

The honest pitch: this is a *speculative refactoring* surface, not a *transactional* one. The commit-phase atomicity is a known limitation, tracked in the source as a future improvement. Marketing should match.

---

## Future improvements

Tracked but not promised:

- **Atomic commit via temp + rename.** Write each staged file to `.<filename>.txn-<id>.tmp`, then atomically rename them all (Linux/macOS rename is POSIX-atomic per file, not across files — but per-file atomicity catches partial-write corruption). Doesn't solve cross-file all-or-nothing, but eliminates the "half-written file" failure mode within each.
- **Cross-file rollback.** Snapshot each file's current content into the transaction before commit; on mid-commit failure, restore snapshots. ~50 LOC, real complexity is around what to do if the rollback itself fails.
- **Long-lived transactions.** A persistent on-disk transaction store (`~/.patchwork/transactions/<id>.json`) for cross-restart staging. Useful for human-driven workflows where the deliberation phase spans hours.

These are not in flight. The speculative-refactoring loop as it exists today is genuinely useful — just don't sell it as more than it is.

---

## See also

- [src/tools/transaction.ts](../src/tools/transaction.ts) — implementation
- [documents/platform-docs.md](platform-docs.md) — full tool reference
- [documents/comparison.md](comparison.md) — Patchwork vs other agentic editors
- [documents/architecture.md](architecture.md) — where transactions sit in the runtime
