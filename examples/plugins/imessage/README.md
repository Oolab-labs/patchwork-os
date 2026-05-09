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

## Set up iMessage on the host Mac

The plugin doesn't configure iMessage — it just drives Messages.app. Do
this once before your first `im_send` call.

### 1. Sign Messages.app into iMessage

1. Open **Messages.app** (Cmd+Space → "Messages").
2. **Messages → Settings… → iMessage**.
3. Sign in with your Apple ID. Same one your iPhone uses, ideally —
   then sends are routed through the same identity.
4. Tick **Enable Messages in iCloud** so conversations sync.
5. Under **You can be reached for messages at**, check the phone number
   and emails you want to be reachable on.
6. Under **Start new conversations from**, pick the address recipients
   should see — usually your `+CC…` phone number or your Apple ID email.

If the iMessage tab says **"Waiting for activation"** for more than a
few minutes, sign out, reboot, sign back in. First-time activation
occasionally hangs on a single attempt.

### 2. Send a manual test message first

Before AppleScript drives anything, you must successfully send one
message manually from this Mac. Otherwise the `buddy` lookup the
plugin uses fails with iMessage error `-25212`.

In Messages.app, open a new chat → To: **your own Apple ID email** →
type "test" → send.

- Blue bubble, no red `!` → iMessage works. Use this email as your
  default `to:` for `im_send` testing.
- Red `!` "Not Delivered" → fix below.

> **Apple ID email is the most reliable test target.** It always
> resolves to iMessage and bypasses any phone-routing issues. Numbers
> not on iMessage (most non-US/EU prefixes, including `+254`) will fail
> from a Mac unless you set up SMS forwarding (step 4).

### 3. Make production recipients reachable

For real recipients (not yourself), the AppleScript looks up the
address as a `buddy` of the iMessage service. That works reliably when
**any one** of these is true:

- The recipient is in your **Contacts.app**, OR
- You've manually messaged them at least once from this Mac, OR
- The recipient's address is itself an Apple ID

For a number you've never messaged, add a Contact first
(Contacts.app → New Contact → save phone in `+CC…` format) and send a
manual hello. After that, `im_send` works for them.

### 4. (Optional) Enable SMS fallback for non-iMessage numbers

Without this, sending to a green-bubble number from a Mac fails. With
it, Messages.app on the Mac proxies the send through your iPhone as
SMS.

1. On the **iPhone** (must be signed into the same Apple ID and on the
   same Wi-Fi or paired via Bluetooth):
2. Settings → **Messages** → **Text Message Forwarding**.
3. Toggle the Mac on. The Mac pops a 6-digit code; enter it on the
   iPhone.

This is the only path to reach non-iMessage recipients — including
most numbers in regions where iMessage adoption is low — from a
Mac-driven plugin.

### 5. First `im_send` call: grant Automation permission

The very first invocation triggers a one-time macOS dialog:

> *"<host process>* wants to control Messages.app."

Click **OK**. The host process is whatever launched the bridge —
Terminal, iTerm, Cursor, Windsurf, VS Code, or `node` if you ran the
bridge directly. macOS records the grant per process binary.

If you missed the prompt or clicked Don't Allow, fix it in:

> System Settings → **Privacy & Security** → **Automation** → expand
> the host process row → tick **Messages**.

If the row isn't there yet, run `im_send` once to register it; the row
appears after the first attempt regardless of outcome.

### 6. Verify the plugin end-to-end

In a Claude Code chat connected to the bridge:

> "Use `im_send` to text `your.appleid@example.com` 'plugin works'."

Expected: blue bubble in Messages.app within a second; tool returns
`{ delivered: true, to: "your.appleid@example.com" }`. If you see an
error, the message points at the fix (Automation permission missing,
recipient unreachable, etc.).

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
