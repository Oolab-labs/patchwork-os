# ADR-0005: HTTP Session Eviction vs 503 Rejection

**Status:** Accepted
**Date:** 2026-03-19

## Context

The Streamable HTTP transport (`src/streamableHttp.ts`) caps concurrent HTTP sessions at `MAX_HTTP_SESSIONS = 5`. Each session is created on `initialize` and destroyed on `DELETE /mcp` or idle timeout.

In v2.4.1 and earlier, when the pool was full, new `initialize` requests received a `503 Service Unavailable` response. This caused a persistent problem:

**Ghost sessions from crashed clients.** When a client process crashes, loses network, or is force-killed, it never sends `DELETE /mcp`. The session lingers in the pool until the idle TTL expires (originally 30 minutes, pruned every 5 minutes). During that window, no new clients can connect — they all get 503.

In practice, this meant:
- Restarting Claude Desktop left a ghost session for up to 30 minutes.
- Network drops during claude.ai connector sessions blocked reconnection.
- Users had to wait or manually restart the bridge to recover.

## Decision

When the session pool is full, **evict the oldest idle session** instead of returning 503.

Rules:
1. Find the session with the oldest `lastActivity` timestamp.
2. If it has been idle for more than 60 seconds, evict it (close its transport, remove from pool) and create the new session in its place.
3. If ALL sessions have been active within the last 60 seconds (genuinely concurrent use), return 503. This preserves the fairness guarantee — truly active sessions are never evicted.

Additionally, reduce TTL and prune frequency:
- `SESSION_TTL_MS`: 30 min → **10 min** (faster reclamation of legitimately abandoned sessions)
- Prune interval: 5 min → **2 min** (check more often)

## Consequences

**Positive:**
- New connections succeed immediately when ghost sessions are present (the common case).
- No user intervention needed after client crashes or network drops.
- 10-min TTL reclaims abandoned sessions 3x faster than before.

**Negative:**
- A session that has been idle for 61 seconds can be evicted even if the client intends to resume. Mitigated by: (a) Claude Desktop and claude.ai both send periodic requests that keep `lastActivity` fresh, and (b) clients must handle 404 "session not found" gracefully and re-initialize anyway.
- The 60-second idle threshold is a heuristic. Too low risks evicting slow-typing users; too high brings back the ghost session problem. 60 seconds was chosen as a conservative middle ground.

**Rate limit bypass prevention:**
Multiple HTTP sessions could theoretically be cycled to bypass per-session rate limits. This is prevented by `setSharedToolRateLimitBucket()` — all HTTP sessions share a single token bucket, so cycling sessions provides no rate limit advantage.

**Location:** `createSession()` and `pruneExpiredSessions()` in `src/streamableHttp.ts`.
