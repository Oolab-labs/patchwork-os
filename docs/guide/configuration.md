# Configuration

Three places hold configuration: the `~/.patchwork` directory (runtime state and `config.json`), environment variables (deployment and supervisor settings), and bridge-daemon flags (see the [CLI reference](cli.md#bridge-daemon-flags)). Claude Code's own `allow` / `ask` / `deny` rules live in `~/.claude/settings.json` and are covered in [delegation-policy.md](../../documents/delegation-policy.md).

## `~/.patchwork` layout

`PATCHWORK_HOME` overrides the location of the whole directory. Set it before starting the bridge and before running any CLI command that reads the ledgers; every path below is relative to it.

| Path | What it is |
|---|---|
| `config.json` | The runtime configuration described in the next section. |
| `recipes/` | Installed recipes, one YAML file (or one directory) each. A `.disabled` marker next to a recipe pauses its triggers. |
| `workers/` | Worker manifests, `*.worker.yaml`. |
| `inbox/` | Where recipes write their Markdown output for you to read. |
| `journal/` | Journal entries written by the journalling recipes. |
| `tokens/` | Connector credentials, one file per connector (or the keychain, if `PATCHWORK_TOKEN_STORAGE_BACKEND` says so). |
| `members.json` | The workspace roster. Absent means one implicit owner. |
| `config/flags.json` | Feature-flag state, including the kill switch. |
| `run-ledgers/` | Per-run pre-image stores that `recipe rollback --run` restores from; kept 14 days. |
| `worker_trust/` | Per-recipe checkpoints of the derived trust dial. |
| `runstore-mirror/` | The durable run-store mirror that `runstore compare` checks against `runs.jsonl`. |
| `butler/` | The errand-outcome shadow ledger and, once any standing permission is granted, its exercise ledger. |
| `*.jsonl` | The evidence ledgers listed in [Concepts](concepts.md#the-evidence-ledgers), plus `sweep_snapshots.jsonl` written by `patchwork sweep`. |

Everything in this directory is yours and is readable without Patchwork. It also holds real task titles, captured output and third-party record ids, so treat the ledgers as operator data: back them up, never paste them.

The bridge's own lock files, activity logs, checkpoints and the analytics config live under `~/.claude/ide/` (`CLAUDE_CONFIG_DIR` overrides `~/.claude`).

## `config.json`

Written by `patchwork init`, edited by the dashboard settings page, and safe to edit by hand with the bridge stopped. Keys that matter to an operator:

| Key | Values | Effect |
|---|---|---|
| `profile` | `"governed"` \| `"compat"` | The governance posture ([Concepts](concepts.md#governed-and-compat-profiles)). Absent means `compat`. Change it with `patchwork profile`, then restart the bridge. |
| `model` | `"claude"`, `"local"`, … | Default model provider for agent steps. `init` sets `local` when it finds Ollama. |
| `defaultModel` | model id | Default model within the provider. |
| `driver` | as `--driver` | Persisted model driver; the dashboard writes it so it survives restart. |
| `apiKeys` | `{ anthropic, openai, google, xai }` | Provider keys. Prefer environment variables or the keychain for anything shared. |
| `localEndpoint`, `localModel` | URL, model id | The local (Ollama / vLLM / OpenAI-compatible) endpoint. |
| `approvalGate` | `"off"` \| `"high"` \| `"all"` | Mirrors `--approval-gate`. Under `governed` the effective floor is `high`. |
| `approvalTimeouts` | `{ low, medium, high }` in ms | Per-tier auto-expiry; `0` means hold until a human decides. |
| `dashboard` | `{ port, requireApproval, pushNotifications, webhookUrl }` | Dashboard port (default 3200), which tiers the dashboard surfaces, push on/off. |
| `recipes` | `{ disabled: [...], timezone }` | Recipes to skip, and the IANA timezone for cron schedules (default UTC). |
| `recipesDir` | path | Where recipes live; defaults to `recipes/` under the home. |
| `plugins.allow` | `[{ spec, version?, integrity? }]` | The allowlist of recipe `servers:` plugins. Under `governed` a plugin not listed is refused at install, save, lint and load. `integrity` is a `sha256-<base64>` over the entrypoint, checked when present. |
| `privacy.destinations` | map of id → destination | The **enforcing** information-boundary registry. Each destination: `type: "local" \| "remote"`, `classifications: [...]` it accepts, optional `forbiddenCategories`, optional `approvable`, and `drivers: [...]` naming the model drivers it covers. Registering the first destination is the opt-in; after that the boundary fails closed. |
| `privacy.shadow` | same shape, under `privacy.shadow.destinations` | A **candidate** policy that is observed against live traffic and never enforced. `patchwork privacy suggest` emits a starter block. |
| `privacy.orchestrator.classification` | a classification | A path-level default classification for orchestrator (Claude subprocess) dispatches. Its presence is the opt-in for enforcing the boundary on that path; a malformed value fails open, deliberately. |
| `claudeBinary` | path | The `claude` CLI for agent steps when `PATH` lookup is unreliable (launchd-spawned bridges). `PATCHWORK_CLAUDE_BINARY` wins over it. |
| `managedSettingsPath` | path | An admin-controlled settings file whose rules cannot be overridden by lower scopes. |
| `pushServiceUrl`, `pushServiceToken`, `pushServiceBaseUrl`, `pushServiceAllowPrivate` | | The mobile push relay ([mobile-oversight.md](../mobile-oversight.md)). |
| `ntfyTopic`, `ntfyServer` | | A public ntfy channel as a push alternative; the topic acts as a bearer, so treat it as a secret. |
| `notifications.slackChannel` | channel id | Where notification recipes post. |
| `enableTimeOfDayAnomaly` | boolean | Opt-in risk-signal heuristic for approvals. |

Classifications, for `data_policy` on steps and for destinations: `public`, `internal`, `personal`, `confidential`, `restricted`. A step that declares nothing is `internal`; an unrecognised value is refused rather than defaulted.

A minimal governed config with a local destination and a shadowed remote one:

```json
{
  "profile": "governed",
  "model": "local",
  "localEndpoint": "http://localhost:11434",
  "recipes": { "timezone": "Europe/London" },
  "privacy": {
    "destinations": {
      "on-box": { "type": "local", "classifications": ["public", "internal", "personal", "confidential"], "drivers": ["local"] }
    },
    "shadow": {
      "destinations": {
        "hosted-model": { "type": "remote", "classifications": ["public", "internal"], "drivers": ["subprocess", "api"] }
      }
    }
  }
}
```

### The workspace policy file

`patchwork.policy.yml` in the **workspace** (not under `~/.patchwork`) holds the recipe policy matrix the governed profile enforces. `patchwork policy explain <recipe>` shows the effective result of it and every other gate for one recipe.

## Environment variables

Most installs need none of these; CLI flags cover the common cases. They exist so supervisors, containers and CI can be configured without flags.

### Bridge and runtime

| Var | Effect |
|---|---|
| `PATCHWORK_HOME` | Override `~/.patchwork` as the runtime home. |
| `PATCHWORK_BRIDGE_URL` / `PATCHWORK_BRIDGE_PORT` | CLI subcommands find the bridge here instead of through the lock files (remote-bridge setups). |
| `PATCHWORK_DASHBOARD_URL` | Public base URL the OAuth callback is served from — first in the `redirect_uri` precedence for every OAuth connector. Must include the dashboard base path. Changing it changes the `redirect_uri` sent to every provider. |
| `PATCHWORK_CLAUDE_BINARY` | Equivalent to `--claude-binary`. |
| `PATCHWORK_RECIPE_REPO_ALLOWLIST` | Comma-separated `owner/repo` list of permitted recipe install sources. |
| `PATCHWORK_TOKEN_DIR` / `PATCHWORK_TOKEN_STORAGE_BACKEND` | Connector-token location and backend (`file` or `keychain`). |
| `PATCHWORK_CRON_CLAIM_REQUIRED` | Truthy: a scheduled recipe **skips** its tick when the cross-process claim store is unwritable, instead of firing anyway. Default off (fail-open), because the conditions that break the store are machine-level and failing closed would stop every schedule on every bridge. Set it where a duplicate is worse than a miss. |
| `PATCHWORK_FLAG_KILL_SWITCH_WRITES` | Freeze the kill-switch state at startup; nothing at runtime can change it. |
| `PATCHWORK_FLAG_WORKER_AUTONOMY` | Enable the worker autonomy gate under `compat` (governed turns it on itself). Needs `--driver subprocess`. |
| `PATCHWORK_FLAG_BUTLER_PROMOTE` | Let `patchwork butler promote` write to the trust ledger. Default off; promotion is one-way. |
| `PATCHWORK_FLAG_UI_SCHEMA_LINT` | Strict UI-schema linting in the recipe editor. |
| `PATCHWORK_ANALYTICS_ENDPOINT` / `PATCHWORK_ANALYTICS_KEY` | Override the opt-in telemetry collector and its shared secret. Env wins over the config file written by `patchwork analytics configure`. |
| `LOCAL_MODEL` / `LOCAL_ENDPOINT` / `LOCAL_API_KEY` / `LOCAL_ENDPOINT_ALLOW_REMOTE` | Local-model driver settings. |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name (default `claude-ide-bridge`). |

### Bridge daemon (legacy `CLAUDE_IDE_BRIDGE_*` names)

| Var | Effect |
|---|---|
| `CLAUDE_IDE_BRIDGE_TOKEN` | Override the auto-generated auth token (must be a UUID). Pair with `--fixed-token` in deployments. |
| `CLAUDE_IDE_BRIDGE_CONFIG` | Path to a JSON config file read at startup, as an alternative to flags. |
| `BRIDGE_BIND_ADDRESS` | Equivalent to `--bind`. |
| `BRIDGE_WEBHOOK_SECRET` | Equivalent to `--webhook-secret`. |
| `CLAUDE_IDE_BRIDGE_ISSUER_URL` | Equivalent to `--issuer-url`; activates OAuth 2.0 mode. |
| `CLAUDE_IDE_BRIDGE_CORS_ORIGINS` | Comma-separated CORS origins (alternative to repeated `--cors-origin`). |
| `CLAUDE_IDE_BRIDGE_TRUST_PROXY` | Truthy: trust `X-Forwarded-For` (behind nginx or Caddy). |
| `CLAUDE_IDE_BRIDGE_GRACE_PERIOD` | ms; session-restore window after a disconnect. |
| `CLAUDE_IDE_BRIDGE_TIMEOUT` | ms; tool execution timeout. |
| `CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE` | Cap on tool result payload size before truncation. |
| `CLAUDE_IDE_BRIDGE_EDITOR` | Editor identity reported to clients. |
| `CLAUDE_IDE_BRIDGE_LINTERS` | Comma-separated linter binaries to probe for. |
| `CLAUDE_IDE_BRIDGE_INSTALL_ALLOWED_HOSTS` | Hostnames permitted for `/recipes/install` sources (default `github.com`). |
| `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL` | Override the recipe runner's temp directory. |
| `CLAUDE_CONFIG_DIR` | Override `~/.claude`, where lock files and activity logs live. |

### Connector credentials

Per-connector overrides for OAuth client credentials (when you host your own OAuth app) or for token-style connectors. The dashboard's connections page is the recommended path; these are for headless and scripted deployments.

| Var(s) | Connector | Type |
|---|---|---|
| `PATCHWORK_GITHUB_CLIENT_ID` / `PATCHWORK_GITHUB_CLIENT_SECRET` | GitHub | OAuth app override |
| `PATCHWORK_SLACK_CLIENT_ID` / `PATCHWORK_SLACK_CLIENT_SECRET` | Slack | OAuth app override |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Gmail | OAuth app override |
| `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` | Google Calendar | OAuth app override |
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` | Google Drive | OAuth app override |
| `ASANA_CLIENT_ID` / `ASANA_CLIENT_SECRET` | Asana | OAuth app override |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord | OAuth app override |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_BASE_URL` | GitLab | OAuth app override + self-hosted base URL |
| `JIRA_API_TOKEN` / `JIRA_EMAIL` / `JIRA_INSTANCE_URL` | Jira | Token |
| `CONFLUENCE_API_TOKEN` / `CONFLUENCE_EMAIL` / `CONFLUENCE_INSTANCE_URL` | Confluence | Token (HTTPS `atlassian.net` only) |
| `LINEAR_API_KEY` | Linear (non-MCP fallback) | Token |
| `NOTION_TOKEN` | Notion | Token |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot | Token |
| `INTERCOM_ACCESS_TOKEN` | Intercom | Token |
| `DATADOG_API_KEY` / `DATADOG_APP_KEY` / `DATADOG_SITE` | Datadog | Token (`SITE` is allowlisted) |
| `PAGERDUTY_TOKEN` / `PAGERDUTY_FROM_EMAIL` | PagerDuty | Token |
| `ZENDESK_API_TOKEN` / `ZENDESK_EMAIL` / `ZENDESK_SUBDOMAIN` | Zendesk | Token |
| `SENTRY_AUTH_TOKEN` | Sentry (non-MCP fallback) | Token |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot token |

What each connector can do with the credential is in [connector-scopes.md](../connector-scopes.md).

### Dashboard

Read from `dashboard/.env.local` (or `.env`) at startup; `dashboard/.env.example` is the template.

| Var | Effect |
|---|---|
| `DASHBOARD_PASSWORD` | The shared password gate. Required for any non-local deployment. Mints an unattributed (v1) session. |
| `DASHBOARD_SESSION_SECRET` | Cookie-signing secret, random, at least 32 bytes. Rotate it to invalidate active sessions; changing the password alone does not. |
| `DASHBOARD_ALLOW_UNAUTHENTICATED` | `1` bypasses the password gate. Local development only. |
| `DASHBOARD_AUTH_FAILURE_WINDOW_MS` / `DASHBOARD_AUTH_MAX_FAILURES` / `DASHBOARD_AUTH_GLOBAL_MAX_FAILURES` / `DASHBOARD_AUTH_LOCKOUT_MS` | Brute-force lockout tuning for the login form. |
| `DASHBOARD_INSTALL_RATE_WINDOW_MS` / `DASHBOARD_INSTALL_RATE_MAX` | Rate limit on the recipe-install endpoint. |
| `PATCHWORK_BRIDGE_URL` / `PATCHWORK_BRIDGE_PORT` / `PATCHWORK_BRIDGE_TOKEN` | Where the dashboard finds the bridge and the bearer it presents. With no URL it discovers a local bridge from the lock files. |
| `PATCHWORK_HOME` | Same meaning as for the bridge; the dashboard reads the same directory. |
| `NEXT_PUBLIC_BASE_PATH` | Base path for mounted-prefix deployments (`/dashboard` under nginx). |
| `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web Push keys for PWA notifications. |
| `PATCHWORK_PUSH_TOKEN` | When set, the dashboard itself serves as a push relay at `POST /api/relay/push`; point the bridge's `pushServiceUrl` and `pushServiceToken` at it. |
| `GITHUB_TOKEN` | Optional read-only token for marketplace fetches, to lift GitHub's unauthenticated rate limit. |

Never put a real token, domain or key into a tracked file. The templates use placeholders for a reason.
