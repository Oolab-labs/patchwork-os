# Operator guide

This guide is for the person who installs, configures and runs Patchwork OS. It explains how the pieces fit, which commands to reach for, and what to do on day two. Reference material (every tool, every env var) lives elsewhere and is linked rather than repeated.

## What Patchwork is

Patchwork OS is a **local-first runtime that sits between an AI agent and the actions it wants to take**. Everything runs on your machine: the runtime, your recipes, your credentials, the approval queue and every record of what happened. The only traffic that leaves is the calls to whichever model you point it at and to the services you deliberately connect.

Work is described as **recipes**: plain YAML with a trigger (cron, webhook, file save, git hook, test run, or by hand) and a list of steps that call tools, connectors or a model. **Workers** are recipes with an identity and a track record.

Every action a recipe takes is classified by blast radius. Under the **approval gate**, reversible actions run freely and consequential ones wait in a queue until a person says yes. A worker starts supervised and earns independence per action type from confirmed outcomes; a policy can also forbid an action outright, so that no approval unlocks it.

Whether the gate is on depends on the **profile**: a fresh `patchwork init` writes `governed`, which turns every safety control on; an upgraded install keeps `compat`, which is byte-identical to what it did before. `patchwork doctor` tells you which you are running. A separate **information boundary** decides what a model destination may be told, and a **kill switch** stops all writes across every bridge at once.

Every decision, approval and outcome is appended to JSONL ledgers under `~/.patchwork` that you can read, export and verify without us.

## Contents, in reading order

1. [Install](install.md) — npm channels, `patchwork init`, the editor extension, auto-start, Windows and headless.
2. [Concepts](concepts.md) — the mental model, one section per idea, each with a link to the authoritative document.
3. [CLI reference](cli.md) — every command grouped as `patchwork --help` groups them, with exit-code semantics.
4. [Configuration](configuration.md) — the `~/.patchwork` layout, `config.json`, environment variables.
5. [Operations](operations.md) — deploying a build, health checks, backups, upgrades, the kill switch, running two bridges.
6. [Security](security.md) — the token, the network defences, dashboard auth, telemetry, reporting a vulnerability.

If you only have ten minutes: read the "What Patchwork is" paragraph above, run the first-run recipe in the [README](../../README.md#first-run-zero-connectors), then come back to [Concepts](concepts.md).

## Related reference

- [Full docs index](../README.md) — every document in the repository, grouped by topic.
- [Platform reference](../../documents/platform-docs.md) — the complete tool, prompt, hook and connector reference.
- [Troubleshooting](../troubleshooting.md) — start here when something does not work.
