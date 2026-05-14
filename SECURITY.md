# Security Policy

Patchwork OS ships an npm package, IDE extensions, a Docker image, an OAuth 2.0 server for remote MCP connectors, and 19+ connectors that handle credentials and personal data (Slack, Stripe, GitHub, Gmail, calendar, etc.). We take vulnerability reports seriously.

## Supported Versions

The current prerelease channel is **beta** (`patchwork-os@0.2.0-beta.x`).

| Channel | Status | Get fixes? |
|---|---|---|
| `beta` (current) | Active | Yes |
| `alpha` | Frozen at `0.2.0-alpha.37` | Critical only, case-by-case |
| Older `claude-ide-bridge` v2.x | End-of-life after the rename to Patchwork OS | No |

The npm `latest` dist-tag tracks the active beta. The VS Code / Open VSX extension `claude-ide-bridge-extension@1.4.x` is the supported extension line.

## Reporting a Vulnerability

**Please do not file vulnerabilities as public GitHub issues.**

Use **GitHub private vulnerability reporting**:

1. Go to [the Security tab](https://github.com/Oolab-labs/patchwork-os/security) on this repo.
2. Click **Report a vulnerability**.
3. Fill in the form — this creates a private advisory thread visible only to you and the maintainers.

Please include, where possible:

- A description of the issue and the affected surface (CLI, dashboard, bridge endpoint, recipe, connector, plugin).
- Reproduction steps or a minimal proof-of-concept.
- Affected versions you've verified (npm version, extension version, ghcr tag).
- Your assessment of impact and any mitigations a user could apply today.

## What to Expect

- **Acknowledgement**: within 3 business days.
- **Initial assessment**: within 7 days, including a severity estimate (CVSS 3.1) and our planned response timeline.
- **Patch + disclosure**: critical issues are typically patched within 14 days; lower severity issues may take longer. We coordinate disclosure with you and credit you in the advisory unless you prefer otherwise.

## Scope

In scope:

- The bridge process (`patchwork-os` / `claude-ide-bridge` npm package).
- The IDE extensions (`claude-ide-bridge-extension` on VS Code Marketplace + Open VSX, the JetBrains plugin).
- The Docker image (`ghcr.io/oolab-labs/patchwork-os`).
- The dashboard (`dashboard/`) including the OAuth approval pages and approval HTTP routes.
- The plugin loader and any code path that handles connector tokens, recipe YAML, or webhook input.

Out of scope (please do not test against without permission):

- Hosted environments belonging to other users.
- Third-party services Patchwork connects to (Slack, GitHub, Stripe, etc.) — report those upstream.
- Self-XSS that requires a user to paste hostile content into their own workspace.
- Findings against unsupported alpha versions where the same issue is already fixed on `beta`.

## Hardening Notes

For users running Patchwork OS:

- Pin to a specific `0.2.0-beta.X` rather than the floating `@beta` or `@latest` tag if reproducibility matters more than fast updates.
- The bridge auth token in `~/.claude/ide/<port>.lock` is mode `0o600`; preserve those permissions.
- The write kill switch (`PATCHWORK_WRITES_DISABLED`) is captured at startup and frozen — do not rely on runtime mutation to disable writes.
- For remote deployments, always front the bridge with a TLS-terminating reverse proxy. See [docs/remote-access.md](docs/remote-access.md).
- Plugin manifests with unknown capability tokens are rejected at parse time. The capability allowlist is intentionally empty until specific runtime enforcement is wired per capability — see [src/pluginLoader.ts](src/pluginLoader.ts) for the current allowlist and [docs/adr/](docs/adr/) for the rationale.

### Command Injection Protections

As of May 14, 2026, the following protections are in place:

- **Shell metacharacter validation**: All command paths and arguments passed to `spawn()` or `execFileSync()` are validated to reject shell metacharacters (`; & | \` $ ( ) { } [ ] < > " ' \\ \n \r`) before execution.
- **Minimal shell usage**: `shell: false` is used by default. On Windows, `shell: true` is only enabled for `.cmd` wrappers after path validation.
- **Direct command execution**: Where possible, `execFileSync()` is used instead of `execSync()` to avoid shell invocation entirely.
- **Validated paths**: Binary paths from environment variables (`BRIDGE`, user config, etc.) are validated before use.

Files with command injection protections:
- `scripts/start-all.mjs` - Validates all spawned commands and arguments
- `vscode-extension/src/bridgeProcess.ts` - Validates binary path before Windows shell execution
- `scripts/smoke/run-all.mjs` - Validates BRIDGE environment variable on startup
- `scripts/postinstall.mjs` - Uses `execFileSync()` instead of shell execution
