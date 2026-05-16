# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for claude-ide-bridge. Each ADR documents a non-obvious design decision — the context, the choice made, and its consequences.

## Index

- [ADR-0001: Dual Version Numbers](0001-dual-version-numbers.md) — `BRIDGE_PROTOCOL_VERSION` vs npm package version
- [ADR-0002: Generation Guards on Reconnect](0002-generation-guards-on-reconnect.md) — stale-callback prevention across socket resets
- [ADR-0003: `isBridge` Lock File Flag](0003-isbridge-lock-file-flag.md) — distinguish bridge-owned locks from IDE-owned locks
- [ADR-0004: Tool Errors as Content Blocks](0004-tool-errors-as-content.md) — `isError: true` for tool failures, JSON-RPC for protocol issues
- [ADR-0005: HTTP Session Eviction](0005-http-session-eviction.md) — 5-concurrent cap, idle-oldest eviction, 2-hour TTL
- [ADR-0006: Approval Gate Design](0006-approval-gate-design.md) — dashboard as CC permission UI, not parallel permission system
- [ADR-0007: Multi-Bridge JSONL Concurrency](0007-multi-bridge-jsonl-concurrency.md) — append-only writes + workspace-scoped reads under one-bridge-per-workspace assumption
- [ADR-0008: Connector Scope Decision](0008-connector-scope-decision.md) — bundled OAuth connectors vs MCP-server delegation
- [ADR-0009: Automation Webhook Fan-out](0009-automation-webhook-fanout.md) — hook nodes can POST to a URL after enqueueing their prompt
- [ADR-0010: Windows Port Helpers](0010-windows-port-helpers.md) — `ensureCmdShim`, `treeKill`, `watchDirectoryWithFallback` shared seams
- [ADR-0011: HTTP `/shutdown` Endpoint](0011-http-shutdown-endpoint.md) — clean exit on Windows where SIGTERM is `TerminateProcess`
- [ADR-0012: `windows-latest` CI Blocking](0012-windows-ci-blocking.md) — graduate Windows matrix from advisory to required check
- [ADR-0013: Write-Tier Kill-Switch](0013-kill-switch.md) — `/kill-switch` endpoint, multi-bridge CLI fan-out, fs.watch convergence, SSE
