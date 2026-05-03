# Webhook recipe templates

> **Anything that can send HTTP can trigger your AI.** iPhone Shortcut, Stream
> Deck, Home Assistant, NFC tag, cron job, monitoring tool, another service —
> if it can POST a body, it can drive a Patchwork recipe.

Five starter templates demonstrating common webhook-triggered workflows. Each
file is a copy-and-adjust starting point.

## Templates

| File | Purpose | Likely trigger sources |
|---|---|---|
| [`capture-thought.yaml`](capture-thought.yaml) | Append a thought to today's journal. | iOS Shortcut + Siri, Stream Deck, NFC tag |
| [`morning-brief.yaml`](morning-brief.yaml) | On-demand morning digest (vs. the cron version). | iOS Shortcut on first unlock, Apple Watch complication |
| [`meeting-prep.yaml`](meeting-prep.yaml) | Brief on attendees + context before the next meeting. | Calendar webhook, Apple Calendar event-start automation |
| [`incident-intake.yaml`](incident-intake.yaml) | Catch-all for monitoring → Linear + Slack alert. | PagerDuty, Sentry, Datadog, uptime checkers |
| [`customer-escalation.yaml`](customer-escalation.yaml) | Enrich a flagged support ticket with CRM data and post to Slack. | Intercom, Zendesk, HelpScout, Front |

## Install

```sh
cp templates/recipes/webhook/capture-thought.yaml ~/.patchwork/recipes/
patchwork stop
patchwork start
```

The dashboard's [Recipes page](http://localhost:3000/dashboard/recipes) will
show the recipe with its full webhook URL + a copyable curl example as soon as
the bridge picks up the new file.

## Triggering from common sources

### iOS Shortcut
1. Shortcuts app → New Shortcut → Add action **Get Contents of URL**
2. Method: `POST`. URL: `http://YOUR-MAC.local:3101/hooks/<path>` (or via Tailscale / your reverse proxy if remote)
3. Headers: `Content-Type: application/json`
4. Request Body → JSON → fill in payload fields the recipe expects
5. Add a Siri phrase ("Hey Siri, capture thought")

### Stream Deck
- Action: **HTTP Request** plugin
- Method: POST, URL as above, body matching the recipe's payload conventions

### Home Assistant
- `automation` block → `service: rest_command.<your-name>` → `url: http://patchwork-bridge:3101/hooks/<path>`

### Plain curl
Each template includes a runnable `curl` example in its docstring — paste it
into a script, a cron job, or your monitoring tool's webhook config.

## Payload conventions

Every recipe references the request body via `{{payload.<field>}}`. The
convention shown in each template's docstring is suggestive, not mandatory —
you can change field names freely; the bridge passes the full JSON body
through.

## Security notes

- Webhook endpoints are unauthenticated by default and bound to localhost
  (`127.0.0.1`). Anything that needs the bridge from another machine should
  go through a reverse proxy with auth (Tailscale, Caddy + Basic Auth,
  Cloudflare Tunnel + Access).
- The receiving recipe's tools still go through your delegation policy — see
  [`templates/policies/`](../../policies/) for tier presets.
- Don't trust payload contents blindly. The agent step in
  `customer-escalation.yaml` and `meeting-prep.yaml` reads the body but
  doesn't auto-act on it; final actions go through Slack/Linear with their
  own auth scopes.
