# imessage — Patchwork OS plugin

Sends iMessage (or SMS, if iPhone-Messages-forwarding is on) from the Mac
running the bridge. One tool: `im_send`. Backed by `osascript` driving
Messages.app. macOS-only.

## Install / load

```sh
# From a fresh checkout of patchwork-os
claude-ide-bridge --plugin ./examples/plugins/imessage --plugin-watch
```

The plugin has no npm dependencies — `osascript` ships with macOS.

## First-run permission

The first time `im_send` runs, macOS will pop a one-time permission
dialog: "*<host process>* wants to control Messages.app." Click **OK**.
If you missed the prompt or clicked Don't Allow, fix it in:

> System Settings → Privacy & Security → Automation → *<your terminal /
> node binary>* → Messages

Without that, every call returns an `im_send: osascript exited 1` error
mentioning Automation permission.

## Usage from Claude Code (chat)

Once loaded, ask Claude something like:

> "Use `im_send` to text +14155551234 a quick hello."

Claude will call the tool with `{ to, body }`. Recipient must be E.164
(`+1…`) or an Apple ID email.

## Usage from a recipe (manual run only)

Recipe YAML can't call MCP plugin tools as `tool: im_send` — the recipe
runner's tool registry is separate from the bridge's MCP registry. Use
an `agent:` step with `mcpAccess: true` to spawn a `claude -p`
subprocess that has the plugin tool injected.

```yaml
# ~/.patchwork/recipes/weather-3day.yaml
name: 3-day weather → iMessage
trigger:
  manual: true
  vars:
    - name: location
      default: "Nairobi"
    - name: phone
      default: "+254XXXXXXXXX"
steps:
  - id: deliver
    agent:
      mcpAccess: true
      prompt: |
        Fetch a 3-day weather forecast for {{ location }} (today, +1, +2).
        You can use https://api.open-meteo.com/v1/forecast with
        forecast_days=3 and hourly=temperature_2m,precipitation,wind_speed_10m
        — geocode the location first via
        https://geocoding-api.open-meteo.com/v1/search.

        Format as a tight 4-line message:
          line 1: "{{ location }} — next 3 days:"
          lines 2-4: "Day Mon: high/low °C, brief conditions"

        Then call the `im_send` MCP tool with:
          to:   "{{ phone }}"
          body: <your formatted 4-line summary>

        Do not ask for confirmation. Run it once and report the tool's
        delivery status back to me.
```

Run it manually:

```sh
patchwork recipe run weather-3day
```

`mcpAccess: true` makes bridge MCP tools (including this plugin's
`im_send`) available inside the Claude subprocess that the agent step
spawns. Bridge must be running with `--plugin ./examples/plugins/imessage`.

## Tool reference

### `im_send`

| Arg | Type | Required | Default | Notes |
|---|---|---|---|---|
| `to` | string | yes | — | E.164 phone (`+14155551234`) or Apple ID email |
| `body` | string | yes | — | Message body, ≤10 000 bytes UTF-8 |
| `timeoutMs` | integer | no | 15 000 | Hard timeout for the osascript subprocess (1 000 – 120 000) |

Returns `{ delivered: boolean, to: string, stderr: string }` as
`structuredContent`. Sets `isError: true` on validation failure, missing
permission, unreachable buddy, or non-zero exit.

## Limitations

- macOS-only. Linux/Windows callers get a clear error.
- "Delivered" means *Messages.app accepted the send*, not that the
  recipient's phone has rendered it. Real delivery telemetry isn't
  available without Messages-DB scraping, which this plugin deliberately
  doesn't do.
- Phone numbers must be in E.164 (`+CC...`). 10-digit US-style without
  the `+1` is rejected to keep the failure visible.
- The script uses `buddy ... of (1st service whose service type =
  iMessage)`. SMS-via-iPhone forwarding will pick that up if the
  recipient isn't on iMessage; otherwise the send may silently fail —
  watch for `-25212` in stderr.
