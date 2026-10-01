# Install

Patchwork OS is one npm package, `patchwork-os`, which installs two binaries: `patchwork` (the runtime CLI) and `claude-ide-bridge` (the same code, named for its original role as an IDE bridge). Every command in this guide is written as `patchwork …`; the other name accepts the same arguments.

**Prerequisites:** Node 22.5 or newer. macOS, Linux and native Windows (no WSL) are supported. If you intend to run recipes with the Claude CLI as the model driver, `claude` must be on your `PATH`.

Install globally rather than with `npx`: `npx` does not persist the binary, so the next command in any guide would not be found.

## 1. Pick a release channel

| Channel | Install | What you get |
|---|---|---|
| `beta` | `npm install -g patchwork-os@beta` | The current supported line, cut by hand from release pull requests. Recommended. |
| `latest` | `npm install -g patchwork-os` | Currently points at the same build as `beta`; a separate stable line has not been cut. |
| `canary` | `npm install -g patchwork-os@canary` | Published automatically on every green merge to `main`, versioned `<base>.canary.<run>`. Tracks `main`; untriaged and unsupported, for trying freshly merged changes. |

Pin an exact version (`patchwork-os@1.2.0-beta.3`) if reproducibility matters more than fast updates. Channel support status is maintained in [SECURITY.md](../../SECURITY.md).

```bash
npm install -g patchwork-os@beta
```

## 2. Initialise `~/.patchwork`

```bash
patchwork init
```

`init` creates `~/.patchwork/` with `config.json`, `recipes/`, `inbox/` and `journal/`, copies the local-only recipe templates into `recipes/`, detects a local Ollama on its default port and sets the model provider to it if found, and registers Patchwork's `PreToolUse` hook in `~/.claude/settings.json` so Claude Code routes tool calls through your delegation policy. Restart Claude Code afterwards; it reads hooks at session start.

On a machine with **no existing `config.json`**, `init` writes `profile: governed`, so the approval gate and every other safety control is on from the first run. On a machine that already has a config, `init` merges and never changes the profile; opt in with `patchwork profile governed` (see [Concepts](concepts.md#governed-and-compat-profiles)).

Flags:

| Flag | Effect |
|---|---|
| `--with-connectors` | Also copy the connector-backed recipe templates (mail, calendar, GitHub and so on). They halt until the connectors they need are authorised. |
| `--force` | Overwrite an existing config instead of merging. |
| `--no-ollama` | Skip Ollama detection. |

Then prove the install with the zero-connector recipe described in the [README](../../README.md#first-run-zero-connectors):

```bash
patchwork recipe run daily-status
```

## 3. Start the stack

```bash
patchwork start
```

`start` is a thin wrapper over `start-all`: it launches the bridge in full mode, `claude --ide` alongside it, and (from a repository clone) the web dashboard. On macOS and Linux it uses tmux when available and falls back to background processes; on Windows it runs natively. Useful flags: `--no-dashboard`, `--workspace <path>`, `--dashboard-port <N>` (default 3200), `--slim`.

To run only the bridge, in the foreground, with no Claude session attached:

```bash
patchwork --workspace .
```

`patchwork status` prints the port, uptime and session count of the running bridge; `patchwork print-token` prints its auth token from the lock file.

### The dashboard

The web dashboard is **not in the npm package** — it is a Next.js app that needs its own build, so it ships with the repository:

```bash
git clone https://github.com/Oolab-labs/patchwork-os && cd patchwork-os/dashboard
```

```bash
npm install && npm run build && npm start
```

It serves on port 3200 by default. Everything in this guide works from the CLI without it; the dashboard is where approvals, traces and connector setup are pleasant rather than possible. Set `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET` before exposing it anywhere (see [Security](security.md#dashboard-authentication)).

## 4. The editor extension

The VS Code-family extension gives the bridge its LSP, debugger and editor-state tools. Without it the bridge still runs: filesystem, shell, git and limited code navigation keep working through built-in fallbacks ([headless quickstart](../../documents/headless-quickstart.md)).

```bash
patchwork install-extension
```

Pass an editor name to target one specifically: `code`, `cursor`, `windsurf` or `antigravity` (`ag`). Then start the bridge and, in another terminal, `claude --ide`. If Claude Code reports that it cannot find an IDE, set `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true`; `init` sets this for you.

JetBrains editors use a companion plugin. Claude Desktop, Gemini CLI, Codex CLI and claude.ai connect over the stdio shim (`patchwork shim`) or Streamable HTTP; see the [platform reference](../../documents/platform-docs.md) and, for Codex, `patchwork codex doctor` in the [CLI reference](cli.md#diagnose).

## 5. Start at login (macOS)

```bash
patchwork launchd install
```

Installs a LaunchAgent labelled `co.patchwork-os.bridge` under `~/Library/LaunchAgents/` that starts the bridge when you log in. `patchwork launchd uninstall` removes it. After upgrading the package, restart the agent so the running code matches the installed code; `patchwork doctor` tells you whether it does — see [Operations](operations.md#deploying-a-build).

One rule matters here if you install from a **repository clone** on macOS: never run `npm install -g .` from a checkout under `~/Documents`, `~/Desktop` or `~/Downloads`. npm creates a symlink into the checkout and macOS then blocks the launchd-spawned process from following it, so the agent appears to install and fails with `EPERM` on first load. Use `npm run install:global` from the clone instead; it packs a tarball and installs a real copy. Details in [Operations](operations.md#deploying-a-build).

## 6. Windows

The bridge, extension and CLI run natively on Windows without WSL. Port handling, shutdown and path rules differ from POSIX; read [docs/windows.md](../windows.md) before deploying there.

## 7. Headless, Docker and remote

- **No editor at all** — the bridge runs fine with no extension attached. [Headless quickstart](../../documents/headless-quickstart.md) covers tokens, Docker and GitHub Actions.
- **Docker** — a `Dockerfile` ships in the repository root and an image is published to `ghcr.io/oolab-labs/patchwork-os`. It is a community-supported path; the systemd route is the one that is actively exercised. See [deploy/README.md](../../deploy/README.md).
- **VPS** — `deploy/bootstrap-new-vps.sh` provisions a fresh server end to end (Node, systemd, nginx, TLS). Any bridge reachable from outside the machine must sit behind a TLS-terminating reverse proxy; see [Remote access](../remote-access.md) and [Security](security.md#exposing-the-bridge-beyond-localhost).

## Verify

```bash
patchwork doctor
```

`doctor` reports whether the running bridge matches the installed build and ends with a governance posture line (`STATUS: GOVERNED` or `NOT GOVERNED`) with reasons. Exit 0 means healthy. For the configuration checks (workspace, git binary, lock file, automation policy) run `patchwork doctor health`; for a behavioural check of the installed package that touches none of your real data, run `patchwork doctor acceptance`.

If something is off, [Troubleshooting](../troubleshooting.md) starts with five quick checks that cover most first-install problems.
