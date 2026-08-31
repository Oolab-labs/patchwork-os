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
- [ADR-0014: /tasks Pagination over Virtualization](0014-tasks-pagination-over-virtualization.md) — capped row render + "show more" instead of `react-virtual`
- [ADR-0015: Cost-Aware Routing](0015-cost-aware-routing.md) — price table, `budget.usdMax` enforcement, per-step downshift gearbox
- [ADR-0016: Approval Hook Fails Closed](0016-approval-hook-fail-closed.md) — `PreToolUse` hook denies on unreachable bridge; `PATCHWORK_APPROVAL_FAIL_OPEN` escape hatch
- [ADR-0017: Decision Record Actor + `forbid`](0017-decision-record-actor-and-forbid.md) — one wire-format migration adding an actor field and a third terminal gate state; `gatePolicyVersion` → `worker-ramp-v1`
- [ADR-0018: Durable Approvals](0018-durable-approvals.md) — Persist the approval request, not the blocked caller; restored entries are `pending, unowned`
- [ADR-0019: The Open-Core Boundary](0019-open-core-boundary.md) — the open runtime emits evidence, only the commercial control plane attests to it; `patchwork-multitenant` scope frozen to infrastructure
- [ADR-0020: Per-Member Authentication](0020-per-member-authentication.md) — a pluggable identity seam resolving to `members.json`; local `scrypt` credentials first, OIDC mapped on `sub` second; unblocks actor attribution and segregation of duties
- [ADR-0021: The Information Boundary](0021-information-boundary.md) — *Proposed.* What a model may KNOW, ahead of what a worker may DO; declared labels + destination registry enforced at `executeAgent`, privacy before capability before cost; detection and policy packs explicitly out of scope
- [ADR-0022: A Durable Evidence Store](0022-durable-evidence-store.md) — `runs` + `run_steps` move to embedded SQLite (`node:sqlite`, no native dep, per ADR-0020's precedent) behind a repository interface; dual-write + shadow-read through one rotation rather than a cutover; JSONL demoted to the append-only export path
- [ADR-0023: The Hosted Tenant Consumes the Published Package](0023-hosted-runtime-sync-model.md) — the multitenant fork's `COPY src/` had drifted 145 files and every governance feature built since June was absent from it; the tenant image installs a pinned `patchwork-os` instead of vendoring a copy, the fork may add files but never edit package files, and the drift gate is transitional and must be deleted rather than silenced
- [ADR-0024: Field-Level Data Labels — Considered and Declined](0024-field-level-data-labels.md) — the prerequisite ADR-0021 deferred twice, closed with a `no`: `ALLOW_REDACTED` has fired 0 times in 254 boundary decisions and the 58-undeclared-steps population that motivated derived labels is now 0 of 74. The workable design is recorded rather than discarded, with a measurable trigger to reopen; redaction at render time is bookkeeping, not detection, and that is why the prerequisite was the right one
