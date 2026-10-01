# Contributing to Patchwork OS — developer guide

This directory is the contributor entry point. It assumes you have read
[CONTRIBUTING.md](../../CONTRIBUTING.md) (ground rules, dev setup, the adapter
contract, commit style) and tells you what that file does not: how the
repository is laid out, which checks actually gate a change, how to write a
test that belongs here, how a release happens, and the privacy rules that make
this public repository safe to work in.

Operators looking for how to *run* Patchwork OS want the
[operator guide](../guide/README.md) instead.

| Page | Read it when |
|---|---|
| [development.md](development.md) | You want to build, test and typecheck exactly the way CI does |
| [gates.md](gates.md) | CI is red and vitest is green, or you are adding anything a gate might scan |
| [architecture-tour.md](architecture-tour.md) | Your first change touches `src/` |
| [testing.md](testing.md) | You are writing or fixing a test |
| [releasing.md](releasing.md) | You are cutting a release or publishing a security advisory |
| [privacy-rules.md](privacy-rules.md) | Before your first commit. Not optional. |

## Repository map

The repository is one npm package (`patchwork-os`) plus four smaller
workspaces that ship separately. Each has its own `package-lock.json` and its
own CI job.

### `src/` — the bridge runtime

Everything the `patchwork` binary does lives here. The top level is wide; the
modules below are the ones a contributor needs to place first.

| Path | Responsibility |
|---|---|
| `src/index.ts` | CLI entry. Dispatches `patchwork <verb>`; the subcommand implementations live in `src/commands/`. |
| `src/bridge.ts` | Process composition root. Loads config, builds the tool registry, the orchestrator, the approval queue, the roster and the logs, then starts the server. |
| `src/server.ts` | The HTTP + WebSocket listener: auth, lock file, every `/...` route (approvals, recipes, connectors, OAuth, dashboard, kill switch). |
| `src/transport.ts` | MCP JSON-RPC over one connection: `initialize`, `tools/list`, `tools/call`, rate limits, timeouts, the kill-switch check before a write tool. |
| `src/streamableHttp.ts` | The Streamable HTTP transport for remote MCP clients, with its session model. |
| `src/extensionClient.ts` | The bridge's view of the VS Code / JetBrains extension over its own WebSocket. See the shape-validation rule in the [architecture tour](architecture-tour.md). |
| `src/tools/` | One file per MCP tool, factory pattern, registered in `src/tools/index.ts`. Has its own README. |
| `src/recipes/` | The recipe engine: YAML parser and validator, two runners (flat and chained), scheduler, trigger dispatch, budgets, the connector tool implementations recipes call. The largest subsystem; its README names the files that matter. |
| `src/workers/` | The autonomy gate: per-worker, per-action-class trust, forbid rules, decision records, trust checkpoints, the control-boundary preview. |
| `src/privacy/` | The information boundary (ADR-0021): data-policy classification, destination registry, boundary receipts and the shadow ledger. |
| `src/identity/` | Workspace identity: roster, roles, per-member credentials, the dashboard session cookie, the auth seam. |
| `src/governance/` | Cross-cutting policy: the governed/compat profile, `computeEffectivePolicy`, the kill-switch reader, secret-value redaction, untrusted-content envelopes. |
| `src/connectors/` | OAuth and PAT connectors to external services, one file per vendor, over `baseConnector.ts`. Has its own README. |
| `src/fp/` | The automation DSL: hook policy → `AutomationProgram` ADT → one interpreter with side effects behind a `Backend` interface. Has its own README. |
| `src/orchestrator/`, `src/claudeOrchestrator.ts`, `src/drivers/` | Spawning model subprocesses (Claude Code, local endpoints, API drivers) as background tasks. |
| `src/butler/` | The errand-outcome channel: standing permissions, fact store, shadow grading. |
| `src/runStore/`, `src/runLog.ts`, `src/ledgerChain.ts`, `src/evidence*.ts` | The run log, its durable mirror, the hash-chained ledgers and the verbs that measure them. |
| `src/oauth.ts`, `src/oauthRoutes.ts`, `src/ssrfGuard.ts`, `src/cors.ts` | The OAuth 2.0 server surface and the single outbound-HTTP guard. |
| `src/plugin.ts`, `src/pluginLoader.ts`, `src/pluginWatcher.ts` | Plugin loading and hot reload. Authoring reference: [documents/plugin-authoring.md](../../documents/plugin-authoring.md). |

Tests sit next to the code: `src/__tests__/` for the top level and
`src/<module>/__tests__/` inside each module.

### `dashboard/` — Next.js operator UI

A separate Next.js app, mounted under a `basePath` (the `/dashboard` prefix in
deployments; see `dashboard/next.config.js`). It talks to the bridge over HTTP
and proxies most bridge routes through `dashboard/src/app/api/`. Its own
lockfile, its own CI job, its own tests under `dashboard/src/**/__tests__/`.

### `vscode-extension/` — the editor companion

The VS Code extension (also loaded by Cursor and Windsurf) that gives the
bridge LSP, debugger and editor state. Wire handlers live in
`vscode-extension/src/handlers/`; their tests in
`vscode-extension/src/__tests__/handlers/`. It has its own version number and
its own versioning rule — see [releasing.md](releasing.md). `intellij-plugin/`
mirrors the same wire methods for JetBrains hosts, and a CI gate keeps the two
in parity.

### `services/push-relay/` — phone notifications

A standalone Express service that fans approval notifications out to phones
without exposing the bridge. Its README explains the files that matter and
links the data-flow document.

### `templates/` — shipped configuration

Recipes, worker manifests, automation policies, scheduled tasks and the
`CLAUDE.md` fragment that `patchwork init` writes into a user's workspace.
**This directory is published in the npm package and copied onto every
installer's machine**, which is why a dedicated gate scans it for real-world
identifiers ([gates.md](gates.md)).

### `scripts/` — the audit gates and release plumbing

Every `scripts/audit-*.mjs` is a check that runs outside vitest and outside
`tsc`. A green test suite cannot see them. [gates.md](gates.md) lists each one.
The rest of the directory is start/stop scripts, the stdio shim for Claude
Desktop, schema generation and the smoke suite.

### `docs/` versus `documents/`

Honestly: the split is historical, and both are tracked and linted.

- `documents/` is **reference**: the feature reference
  ([platform-docs.md](../../documents/platform-docs.md)), the architecture and
  data-flow references, the style guide, plugin authoring, the roadmap, the
  tool-schema changelog.
- `docs/` is **everything else**: the ADRs under [docs/adr/](../adr/README.md),
  operator runbooks under `docs/runbooks/`, the protocol spec, platform notes
  such as [windows.md](../windows.md), the release checklist, the in-flight
  ledger, this guide, and a number of plan and investigation documents that
  are historical records rather than current instructions.

When in doubt, a reference that describes the system as it is goes in
`documents/`; a decision, a procedure or a dated record goes in `docs/`.

## `docs/in-flight.md` — the coordination ledger

[docs/in-flight.md](../in-flight.md) exists because two sessions once built
the same fix without knowing about each other. Before starting non-trivial
work (a new branch, or anything touching a shared subsystem such as the
runners, the worker gate or bridge startup), add a line to its **Active**
section.

The one rule that is not obvious: **retire your own entry before merging, in
the PR itself.** Move your line to *Recently closed* as the last commit of
your PR. The gate `scripts/audit-in-flight.mjs` fails `main` when an Active
entry names a branch whose PR is already merged, so leaving the line for a
later sweep turns `main` red the moment your PR lands. Read the file's header
for the full reasoning.

## A first week's reading order

1. [CONTRIBUTING.md](../../CONTRIBUTING.md), then
   [privacy-rules.md](privacy-rules.md). The second one is the rule that
   cannot be undone after a push.
2. [documents/architecture.md](../../documents/architecture.md) for the shape,
   then [architecture-tour.md](architecture-tour.md) for the mistakes that
   shape invites.
3. The ADRs an incoming contributor must read first, in this order:
   - [ADR-0004](../adr/0004-tool-errors-as-content.md) — tool errors are
     content blocks, never JSON-RPC errors
   - [ADR-0013](../adr/0013-kill-switch.md) — the write-tier kill switch
   - [ADR-0016](../adr/0016-approval-hook-fail-closed.md) — the approval hook
     fails closed
   - [ADR-0017](../adr/0017-decision-record-actor-and-forbid.md) and
     [ADR-0018](../adr/0018-durable-approvals.md) — decision records and
     durable approvals
   - [ADR-0019](../adr/0019-open-core-boundary.md) — what may and may not be
     built in this MIT repository
   - [ADR-0021](../adr/0021-information-boundary.md) — what a model
     destination may be told
   - [ADR-0025](../adr/0025-evidence-spine.md) — how ledgers join, and why
     absence is never backfilled
   - [ADR-0026](../adr/0026-governed-profile.md) — the governed profile
   - [ADR-0027](../adr/0027-tamper-evident-ledgers.md) — hash-chained ledgers

   The full index is [docs/adr/README.md](../adr/README.md). Read any ADR
   before touching version numbers, lock files, error codes, session
   management or reconnect logic.
4. [development.md](development.md) and [gates.md](gates.md) before your first
   push.
5. [documents/data-reference.md](../../documents/data-reference.md) and
   [docs/protocol-spec.md](../protocol-spec.md) when your change touches a
   connection, auth or state path.
6. [documents/styleguide.md](../../documents/styleguide.md) before adding a
   tool, handler or response shape, and
   [documents/tool-schema-changelog.md](../../documents/tool-schema-changelog.md)
   if you change a tool's schema.
7. [docs/windows.md](../windows.md#common-patterns-when-contributing) — the
   Windows CI cell is blocking, and that section lists the patterns that keep
   it green.
8. [docs/cowork.md](../cowork.md) if you work from a Cowork (computer-use)
   session: it runs in a separate worktree and has no bridge tools.
