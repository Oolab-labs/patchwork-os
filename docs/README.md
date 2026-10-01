# Patchwork OS documentation

Start from the entry point that matches what you are doing:

| You are… | Start here |
|---|---|
| **Operating** a Patchwork install — installing, configuring, running recipes, approving actions, keeping it healthy | [Operator guide](guide/README.md) |
| **Contributing** code, tests or docs to the repository | [Contributor guide](contributing/README.md) |
| **An agent** (Claude Code or another coding agent) working in this repository | [docs/agents.md](agents.md) — the short contract; `CLAUDE.md` holds the lore |

Everything below is the full map of reference material, grouped by topic. The operator guide links into it; this page exists so nothing is reachable only by knowing the path.

## Project

| Document | What it covers |
|---|---|
| [README.md](../README.md) | What Patchwork OS is, install in two commands, the governed-vs-compat table, first run |
| [CHANGELOG.md](../CHANGELOG.md) | Release notes per version |
| [SECURITY.md](../SECURITY.md) | Supported channels, how to report a vulnerability, hardening notes |
| [THREAT-MODEL.md](../THREAT-MODEL.md) | What the system is designed to resist, what it is not, residual risks |
| [LICENSING.md](../LICENSING.md) | Which parts are MIT and where the open-core line sits |
| [TRADEMARK.md](../TRADEMARK.md) | Use of the name and marks |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Ground rules for pull requests, including agent-authored ones |
| [CLA.md](../CLA.md) | Contributor licence agreement |

## Operator guide

| Document | What it covers |
|---|---|
| [guide/README.md](guide/README.md) | Table of contents and reading order |
| [guide/install.md](guide/install.md) | npm channels, `patchwork init`, the extension, LaunchAgent, Windows, headless |
| [guide/concepts.md](guide/concepts.md) | The mental model: bridge, tools, recipes, gate, workers, profiles, boundary, ledgers, kill switch, identity |
| [guide/cli.md](guide/cli.md) | Every `patchwork` command, grouped as `--help` groups them, with exit-code semantics |
| [guide/configuration.md](guide/configuration.md) | `~/.patchwork` layout, `config.json` keys, environment variables |
| [guide/operations.md](guide/operations.md) | Deploying a build, health checks, backups, upgrading, the kill switch, two bridges |
| [guide/security.md](guide/security.md) | The operator-facing security model and the advisories list |

## Platform reference

| Document | What it covers |
|---|---|
| [documents/platform-docs.md](../documents/platform-docs.md) | The full tool reference, MCP prompts, automation hooks, approval gate, connectors, model support |
| [documents/prompts-reference.md](../documents/prompts-reference.md) | Every MCP prompt the bridge ships |
| [documents/architecture.md](../documents/architecture.md) | How the external surfaces connect to the internal subsystems |
| [documents/data-reference.md](../documents/data-reference.md) | Data flows, state management and protocol details |
| [documents/tool-schema-changelog.md](../documents/tool-schema-changelog.md) | Append-only log of breaking tool-schema changes |
| [protocol-spec.md](protocol-spec.md) | Wire protocol for anyone building a bridge client |
| [multi-ide.md](multi-ide.md) | Multiple editors, sessions and Claude Desktop on one bridge |
| [restart-endpoint.md](restart-endpoint.md) | In-place restart via `POST /restart` |
| [perf-baseline.md](perf-baseline.md) | Round-trip latency snapshot for representative tool calls |

## Recipes, triggers and automation

| Document | What it covers |
|---|---|
| [documents/triggers.md](../documents/triggers.md) | The trigger types, with webhook examples for phones, Stream Deck and Home Assistant |
| [recipe-template-gotchas.md](recipe-template-gotchas.md) | Template-resolution edges that trip up real recipes |
| [recipe-phone-notifications.md](recipe-phone-notifications.md) | Getting recipe output to a phone |
| [automation.md](automation.md) | Event-driven automation hooks and the policy file |
| [self-healing-quickstart.md](self-healing-quickstart.md) | From install to "Claude told me what was wrong without being asked" |
| [documents/use-cases.md](../documents/use-cases.md) | Worked workflows with real tool calls |
| [documents/live-toolsmithing.md](../documents/live-toolsmithing.md) | Writing tools while the bridge is running |
| [documents/speculative-refactoring.md](../documents/speculative-refactoring.md) | The multi-file transaction surface |
| [documents/shadow-run-harness.md](../documents/shadow-run-harness.md) | Replaying historical runs through a candidate classifier |
| [decision-replay-debugger.md](decision-replay-debugger.md) | Running a new policy against captured old approval inputs |

## Governance: approvals, workers, privacy, evidence

| Document | What it covers |
|---|---|
| [documents/delegation-policy.md](../documents/delegation-policy.md) | The allow / ask / deny policy syntax and where settings live |
| [worker-autonomy-policy-gate.md](worker-autonomy-policy-gate.md) | The worker trust ramp and gate in full |
| [runbooks/worker-autonomy-dogfood.md](runbooks/worker-autonomy-dogfood.md) | Operator runbook for a live worker-autonomy campaign |
| [documents/data-sovereignty.md](../documents/data-sovereignty.md) | What stays local, running fully local, exporting the audit log |
| [privacy-policy.md](privacy-policy.md) | What the software processes, stores and (only if opted in) sends |
| [connector-scopes.md](connector-scopes.md) | What each connector asks for, and who decides |
| [push-relay-data-flow.md](push-relay-data-flow.md) | What leaves the machine when mobile approvals are enabled |
| [adr/README.md](adr/README.md) | Index of every Architecture Decision Record |

ADRs an operator is most likely to need: [ADR-0006 approval gate](adr/0006-approval-gate-design.md) · [ADR-0013 kill switch](adr/0013-kill-switch.md) · [ADR-0017 forbid and decision actors](adr/0017-decision-record-actor-and-forbid.md) · [ADR-0018 durable approvals](adr/0018-durable-approvals.md) · [ADR-0020 per-member authentication](adr/0020-per-member-authentication.md) · [ADR-0021 information boundary](adr/0021-information-boundary.md) · [ADR-0025 evidence spine](adr/0025-evidence-spine.md) · [ADR-0026 governed profile](adr/0026-governed-profile.md) · [ADR-0027 tamper-evident ledgers](adr/0027-tamper-evident-ledgers.md).

## Deployment and platforms

| Document | What it covers |
|---|---|
| [documents/headless-quickstart.md](../documents/headless-quickstart.md) | Running without an editor: Docker, GitHub Actions, VPS, tokens |
| [remote-access.md](remote-access.md) | Remote-SSH, systemd, reverse proxy with TLS, OAuth 2.0 for connectors |
| [ip-allowlist.md](ip-allowlist.md) | Restricting network access to an exposed bridge |
| [ssh-resilience.md](ssh-resilience.md) | Keeping a session alive across SSH drops |
| [windows.md](windows.md) | Native Windows support and what differs from POSIX |
| [spawn-a-bridge.md](spawn-a-bridge.md) | Launching a fresh bridge programmatically |
| [demo-setup.md](demo-setup.md) | A persistent public demo instance |
| [mlx-integration.md](mlx-integration.md) | Local models on Apple Silicon via MLX |
| [documents/managed-agents.md](../documents/managed-agents.md) | Attaching a hosted bridge to a cloud-managed agent |
| [../deploy/README.md](../deploy/README.md) | VPS deployment scripts, systemd and nginx templates |

## Oversight from a phone

| Document | What it covers |
|---|---|
| [mobile-oversight.md](mobile-oversight.md) | Push notifications and tap-to-approve setup |
| [mobile-oversight-self-host.md](mobile-oversight-self-host.md) | Wiring the same path against a self-hosted relay |
| [mobile-oversight-mvp.md](mobile-oversight-mvp.md) | The original plan for the phone path |

## Editors and clients

| Document | What it covers |
|---|---|
| [cowork.md](cowork.md) | Using the bridge with Claude's computer-use mode |
| [documents/plugin-authoring.md](../documents/plugin-authoring.md) | Manifest schema, entrypoint API and distribution for plugins |
| [documents/comparison.md](../documents/comparison.md) | How Patchwork compares to other ways of doing this |

## Help

| Document | What it covers |
|---|---|
| [troubleshooting.md](troubleshooting.md) | The five quick checks, then symptom-by-symptom fixes |
| [migration.md](migration.md) | Upgrading between versions |
| [release-checklist.md](release-checklist.md) | What a maintainer does before tagging |
| [documents/roadmap.md](../documents/roadmap.md) | Development direction |
| [documents/styleguide.md](../documents/styleguide.md) | Code conventions, UI patterns and output formats |
