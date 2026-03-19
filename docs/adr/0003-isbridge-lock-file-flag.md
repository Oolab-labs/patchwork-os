# ADR-0003: isBridge Lock File Flag

**Status:** Accepted
**Date:** 2026-03-19

## Context

The bridge and VS Code-compatible IDEs (VS Code, Cursor, Windsurf) all write lock files to the same directory: `~/.claude/ide/<port>.lock`. The stdio shim (used by Claude Desktop) scans this directory to find a running bridge and connect to it.

In early 2026, Windsurf started writing its own lock files to the same directory when its built-in Claude integration activated. The stdio shim couldn't distinguish between a bridge lock file and a Windsurf IDE lock file. It would connect to Windsurf's WebSocket instead of the bridge's, causing silent failures — the tool schemas didn't match, requests timed out, and the user saw "extension disconnected" errors with no clear cause.

The same collision could happen with any IDE that writes lock files to `~/.claude/ide/`.

## Decision

Add an `isBridge: true` field to the lock file JSON written by the bridge (`src/lockfile.ts`). The stdio shim and extension's lock file scanner check for this field and skip any lock file that doesn't have it.

Lock file format:

```json
{
  "pid": 12345,
  "startedAt": 1710000000000,
  "workspace": "/path/to/project",
  "workspaceFolders": ["/path/to/project"],
  "ideName": "bridge",
  "isBridge": true,
  "transport": "ws",
  "authToken": "<token>"
}
```

The extension's `lockfiles.ts` scanner filters with:

```typescript
if (!lockData.isBridge) continue; // skip IDE-owned locks
```

## Consequences

**Positive:**
- Clean separation between bridge and IDE lock files in a shared directory.
- No directory restructuring needed — both can coexist in `~/.claude/ide/`.
- Backward compatible — old lock files without `isBridge` are simply skipped (safe default).

**Negative:**
- One extra field in every lock file (trivial size impact).
- If a future IDE fork also sets `isBridge: true` in its lock files, the collision returns. Mitigated by the `ideName` field — the bridge always sets `ideName: "bridge"`.

**Related:**
- Lock file security: `O_EXCL` creation prevents symlink attacks. Permissions `0o600`. Directory mode `0o700`. See `src/lockfile.ts`.
- Stale cleanup: `cleanStale()` checks PID liveness via `process.kill(pid, 0)` with a 24-hour age guard for PID reuse.
