# ADR-0002: Generation Guards on Extension Reconnect

**Status:** Accepted
**Date:** 2026-03-19

## Context

Both the VS Code extension (`BridgeConnection`) and the bridge transport (`McpTransport`) use WebSocket connections that can disconnect and reconnect at any time — laptop sleep, bridge restart, network blip. Each reconnect creates a new WebSocket with new event listeners.

The problem: JavaScript closures capture references to the connection they were created for. When a reconnect happens, old listeners from the previous connection may still fire (e.g., a delayed `close` event, a late `message` delivery, a timeout callback). If these stale callbacks execute, they corrupt the new connection's state:

- `handleDisconnect()` fires on the new (healthy) socket
- A `message` handler processes a response from the old bridge instance
- A `finally` block from an old tool execution clears the new session's `AbortController`

This class of bug caused intermittent "connection drops immediately after reconnect" issues in Windsurf.

## Decision

Use a **monotonically increasing generation counter** checked at the top of every WebSocket callback.

Pattern (used in both `connection.ts` and `transport.ts`):

```typescript
private generation = 0;

connect() {
  const gen = ++this.generation;

  ws.on("open", () => {
    if (gen !== this.generation) return; // stale — bail
    // ... safe to touch shared state
  });

  ws.on("close", () => {
    if (gen !== this.generation) return;
    this.handleDisconnect();
  });
}
```

The counter is incremented atomically at the start of each `connect()` call. Every callback captures `gen` in its closure and compares it to `this.generation` before acting. If they differ, the callback belongs to a previous connection and is silently dropped.

The same pattern is applied to `finally` blocks in tool execution (`transport.ts`) to prevent orphaned cleanup from a timed-out tool on a previous generation from clearing the new session's abort controller.

## Consequences

**Positive:**
- Complete elimination of stale-callback races on reconnect.
- No need for explicit listener removal — old listeners self-deactivate via the generation check.
- Pattern is simple to audit: grep for `this.generation` and verify every callback checks it.

**Negative:**
- Code verbosity — every callback in `connect()` starts with `if (gen !== this.generation) return`.
- Easy to forget when adding new callbacks. Convention: the generation check must be the **first line** of every WebSocket event handler inside `connect()`.

**Locations:**
- `vscode-extension/src/connection.ts` — `this.generation` field, checked in `open`, `close`, `error`, `message`, `pong` handlers and notification dispatch.
- `src/transport.ts` — `this.generation` field, checked in `attach()` listeners and tool execution `finally` blocks.
