# ADR-0001: Dual Version Numbers (BRIDGE_PROTOCOL_VERSION vs PACKAGE_VERSION)

**Status:** Accepted
**Date:** 2026-03-19

## Context

The bridge participates in two distinct version conversations:

1. **MCP protocol handshake** — during `initialize`, the bridge reports a `protocolVersion` that clients use to negotiate capabilities. Changing this value can break existing clients that don't support the new version.

2. **npm package releases** — every bug fix, feature, or docs change bumps the npm version. These happen frequently (50+ releases to date) and rarely affect the wire format.

Early in development, both used the same value from `package.json`. This meant every npm publish changed the protocol version, which triggered unnecessary capability re-negotiation warnings in Claude Code and broke version-pinned clients.

## Decision

Maintain two separate version constants in `src/version.ts`:

- **`PACKAGE_VERSION`** — read from `package.json` at runtime. Bumped on every npm release. Exposed in the `/ping` health check and in `serverInfo._meta.packageVersion`.

- **`BRIDGE_PROTOCOL_VERSION`** (currently `"1.1.0"`) — hardcoded string. Only bumped when the wire-format contract changes in a way that requires coordinated updates on both the bridge and the extension side (e.g., new JSON-RPC method, changed message shape, removed capability).

The MCP `initialize` response uses `BRIDGE_PROTOCOL_VERSION` for the handshake. Clients that need the npm version for debugging or feature-gating can read `_meta.packageVersion` from `serverInfo`.

## Consequences

**Positive:**
- npm releases never break existing client connections.
- Clients can cache tool schemas across npm version bumps without re-initializing.
- The `/ping` endpoint still exposes the exact npm version for debugging.

**Negative:**
- Contributors must remember that bumping `package.json` does NOT bump the protocol version.
- When a wire-format change IS needed, both `BRIDGE_PROTOCOL_VERSION` and the extension's `BRIDGE_VERSION` constant must be updated in lockstep.

**How to decide which to bump:**
- Changed tool schema, added/removed JSON-RPC method, changed message envelope → bump `BRIDGE_PROTOCOL_VERSION`.
- Everything else (new tool, bug fix, config change, docs) → bump `package.json` only.
