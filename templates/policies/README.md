# Delegation policy templates

Five starter delegation policies for common personas. Each file is a partial
`~/.patchwork/config.json` you can copy or merge into your own config.

> A delegation policy answers three questions: *what may my AI do without
> asking, what needs approval, and what is forbidden?* See the strategic
> plan §1.2 for the framing.

## Personas

| File | Mode | Push | When to pick |
|---|---|---|---|
| [`conservative.json`](conservative.json) | `all` | yes | First-time users, sensitive personal data, learning what your AI actually does. |
| [`developer.json`](developer.json) | `high` | no | Solo engineer at workstation. Dashboard-only oversight is enough. |
| [`headless-ci.json`](headless-ci.json) | `off` | no | Build agents, schedulers, CI runners. **No human in the loop** — pair with disabled write recipes. |
| [`regulated-industry.json`](regulated-industry.json) | `all` | yes | Medicine, law, journalism, finance, gov. Includes managed-settings pointer for compliance-team override. |
| [`personal-assistant.json`](personal-assistant.json) | `high` | yes | Non-developer life automation. Inbox, calendar, smart home — approve from phone. |

## How to apply

### Fresh install

Copy the file into place:

```sh
cp templates/policies/developer.json ~/.patchwork/config.json
```

Then add your driver/model (run `patchwork init` for guided setup, or edit
`config.json` to add `model`, `driver`, `apiKeys`, `localEndpoint`, etc.).

### Already configured

Merge with `jq` (drops the `_persona` / `_summary` documentation fields):

```sh
jq -s '.[0] * (.[1] | with_entries(select(.key | startswith("_") | not)))' \
   ~/.patchwork/config.json templates/policies/developer.json \
   > ~/.patchwork/config.json.new \
&& mv ~/.patchwork/config.json.new ~/.patchwork/config.json
```

### Restart

```sh
patchwork stop
patchwork start
```

Restart Claude Code too — the `PreToolUse` hook reads bridge state at session
start.

## Verify

Open the dashboard at `http://localhost:3000/settings`. The **Delegation
policy** card should reflect your chosen mode. Trigger a tool call and watch
`/approvals` — the detail page shows *why* a call was gated (matched rule +
risk tier).

## Key fields

- `approvalGate` — `"off" | "high" | "all"`. Coarse gate for `PreToolUse`
  routing.
- `dashboard.requireApproval` — `["low" | "medium" | "high"]`. Which risk
  tiers require human approval inside the dashboard queue.
- `dashboard.pushNotifications` — send approval requests to your phone.
- `enableTimeOfDayAnomaly` — opt-in heuristic 10. Flags calls happening
  outside your typical activity window. Off by default.
- `managedSettingsPath` — admin-controlled overrides, highest precedence.
  Users cannot override fields set there.
- `recipes.disabled` — opt out of specific recipes by name.
