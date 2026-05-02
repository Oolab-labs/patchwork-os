# Anything Can Trigger Your AI

> Any device that can send HTTP can become an input to a Patchwork recipe. iPhone Shortcuts, Stream Deck buttons, Home Assistant automations, NFC tags, motion sensors, barcode scanners, cron jobs, and your terminal.

This guide covers the seven trigger types Patchwork supports today, with copy-paste examples for the four most common ones. The recipe machinery is identical across triggers — the only thing that changes is what fires it.

| Trigger type | Fires when | Recipe `trigger.type` | Best for |
|---|---|---|---|
| **webhook** | any HTTP `POST /hooks/*` arrives | `webhook` | iPhone Shortcuts, Stream Deck, Home Assistant, GitHub Actions, Sentry, generic IoT |
| **cron** | scheduled time | `cron` | morning briefs, weekly reports, nightly cleanup |
| **file_watch** | matching files saved | `file_watch` | lint-on-save, screenshot capture, build-on-change |
| **git_hook** | `post-commit` / `pre-push` / `post-merge` | `git_hook` | commit notes, push checks, branch syncing |
| **on_recipe_save** | any `.yaml` saved | hook (settings) | recipe-authoring loop |
| **on_test_run** | test runner finishes | hook (settings) | failure triage, post-pass cleanup |
| **manual** | `patchwork run <name>` | `manual` | one-shot scripts, debug runs |

For trigger types that fire from **outside the runtime** (webhook, cron) the recipe declares them. For trigger types that fire from **inside the runtime** (file_watch, git_hook, on_recipe_save, on_test_run) the recipe still declares them but the orchestrator wires the hook on bridge start.

The rest of this doc focuses on **webhooks** — the trigger that opens the door to every external system that can talk HTTP.

---

## The webhook contract

```
POST http://localhost:3100/hooks/<your-path-here>
Authorization: Bearer <your-bridge-token>
Content-Type: application/json

{ "anything": "you-want", "max-size": "8 KB" }
```

What happens:

1. The bridge looks up `~/.patchwork/recipes/*.yaml` for a recipe whose trigger declares `path: /hooks/<your-path-here>`.
2. If found, the recipe runs with `payload` (the parsed JSON body) bound into the template context.
3. Approval gates fire on any write/external step — the recipe doesn't bypass policy because a webhook fired it.

Returns:

| Status | Meaning |
|---|---|
| 200 | recipe accepted (the run itself is async — check the dashboard for outcome) |
| 401 | missing or wrong `Authorization: Bearer` header |
| 404 | no recipe matches that hook path |
| 503 | bridge running without `--claude-driver subprocess` (orchestrator unavailable) |

**Get your token:**

```bash
patchwork print-token
```

Or read it from the lock file: `~/.claude/ide/<port>.lock`'s `authToken` field.

**8 KB payload cap.** Larger payloads get truncated with a `…[truncated]` marker. If you need bigger, write the data to disk first and POST the path.

**Auth is mandatory.** The `/hooks/*` endpoint is not on the loopback bypass list. Every example below includes the bearer.

---

## Example recipe (the one all the integrations below trigger)

Save this as `~/.patchwork/recipes/capture-thought.yaml`:

```yaml
apiVersion: patchwork.sh/v1
name: capture-thought
description: Append a payload to ~/.patchwork/inbox/thoughts.md with timestamp
trigger:
  type: webhook
  path: /hooks/thought
steps:
  - tool: file.append
    path: ~/.patchwork/inbox/thoughts.md
    content: |
      ## {{date}}
      {{payload.text}}
      ---
```

Confirm it's installed:

```bash
patchwork recipe list | grep capture-thought
```

Now you have a webhook your phone, your Stream Deck, or your terminal can hit.

---

## 1. iPhone Shortcuts → webhook recipe

iPhone Shortcuts can do this from anywhere — Lock Screen, Action Button, Siri, Apple Watch, Home Screen widget. Setup time: ~2 minutes.

### Build the Shortcut

1. Open the **Shortcuts** app on iOS.
2. Tap **+** to create a new shortcut.
3. Add action: **Ask for Input**
   - Input Type: Text
   - Prompt: "What's the thought?"
4. Add action: **Get Contents of URL**
   - URL: `https://your-bridge.example.com/hooks/thought` (or `http://192.168.x.x:3100/hooks/thought` for LAN)
   - Method: POST
   - Headers:
     - `Authorization` → `Bearer YOUR-BRIDGE-TOKEN`
     - `Content-Type` → `application/json`
   - Request Body:
     - Type: JSON
     - Field: `text` → "Provided Input" (variable from step 3)
5. Name the shortcut **"Capture Thought"**, give it an icon.
6. Tap **Add to Home Screen** OR assign to the Action Button (Settings → Action Button).

### Use it

Press the Action Button. Type the thought. Tap done. Patchwork appends it to your inbox.

> **Tip:** Add a **Show Notification** action after the URL request showing the response status, so you know the webhook fired without opening the dashboard.

### Variants

- **Capture photo + text:** add a **Take Photo** action, base64-encode it, include `image` field in the JSON. Recipe step decodes and writes to disk.
- **Voice memo:** **Dictate Text** action, then POST. Hands-free capture from Apple Watch.
- **Location-aware:** include `Current Location` from Get Current Location action; recipe parses lat/lng.

---

## 2. Stream Deck → webhook recipe

For the Elgato Stream Deck (or any Stream Deck-compatible device — Loupedeck, etc.). Setup time: ~3 minutes.

### Build the button

1. Open Stream Deck software.
2. Drag the **System / Open** action onto a button.
3. Replace it with a **Multi Action** that includes one **System / Run** step:
   - Mac: `curl -X POST https://your-bridge.example.com/hooks/thought -H "Authorization: Bearer YOUR-TOKEN" -H "Content-Type: application/json" -d '{"text":"Stream Deck button"}'`
   - Windows / generic: same command, run via `cmd.exe /c` or use the **Visual Studio Code → Terminal Command** plugin

For richer button UX (input prompts, response feedback) install the [Stream Deck API plugin](https://marketplace.elgato.com/products?search=API) and bind a button to a webhook with custom payload.

### Use cases that work well

- **"Start focus session"** button: POST `{ "mode": "focus" }`. Recipe writes `~/.patchwork/state/focus.flag` and silences notifications.
- **"Dump terminal context"** button: POST `{ "context": "current-terminal" }`. Recipe runs `getTerminalOutput`, saves to inbox.
- **"Triage now"** button: POST `{ "command": "triage" }`. Recipe runs `inbox-triage` programmatically.

---

## 3. Home Assistant → webhook recipe

Bridge your home automation to Patchwork: motion sensor → AI brief; door open → log; smart button → recipe.

### Setup

In `~/.homeassistant/configuration.yaml`:

```yaml
rest_command:
  patchwork_thought:
    url: "https://your-bridge.example.com/hooks/thought"
    method: POST
    headers:
      Authorization: "Bearer YOUR-BRIDGE-TOKEN"
      Content-Type: "application/json"
    payload: '{"text": "{{ message }}"}'
```

Then in an automation:

```yaml
automation:
  - alias: "Daily standup reminder via Patchwork"
    trigger:
      platform: time
      at: "08:30:00"
    action:
      service: rest_command.patchwork_thought
      data:
        message: "Time to write standup notes"
```

Or a more interesting one:

```yaml
automation:
  - alias: "Front door opened — capture context"
    trigger:
      platform: state
      entity_id: binary_sensor.front_door
      to: "on"
    action:
      service: rest_command.patchwork_thought
      data:
        message: "Front door opened at {{ now() }}"
```

### Use cases

- **Motion sensor + Patchwork:** "movement detected in office at 03:14" → recipe checks running processes, writes anomaly note.
- **Aqara button (zigbee):** triple-press fires a "summarize my day" recipe.
- **NFC tag at front door:** scan tag → POST `{ "event": "leaving" }` → recipe queues a daily brief for the morning.

---

## 4. curl / any HTTP client

The lowest-tech path. Useful for `crontab`, CI runners, GitHub Actions, custom scripts, or any language that can speak HTTP.

```bash
# Fire a thought
curl -X POST https://your-bridge.example.com/hooks/thought \
  -H "Authorization: Bearer $PATCHWORK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "from a script"}'

# With env-var substitution
curl -X POST https://your-bridge.example.com/hooks/incident \
  -H "Authorization: Bearer $PATCHWORK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"alert\": \"$(cat /tmp/last-alert.json)\"}"

# Empty payload is fine — recipe runs without a `payload` template var
curl -X POST https://your-bridge.example.com/hooks/sweep \
  -H "Authorization: Bearer $PATCHWORK_TOKEN"
```

### GitHub Actions example

```yaml
name: Triage failed CI run
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  triage:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - name: POST to Patchwork
        run: |
          curl -X POST https://your-bridge.example.com/hooks/ci-failure \
            -H "Authorization: Bearer ${{ secrets.PATCHWORK_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{"run_id": "${{ github.event.workflow_run.id }}", "branch": "${{ github.event.workflow_run.head_branch }}"}'
```

The matching recipe at `~/.patchwork/recipes/ci-failure.yaml` can fetch the run logs, run an LLM triage step, and write a note to your inbox before you wake up.

---

## Beyond webhooks: the four other trigger types

For triggers that fire from inside the runtime, the recipe declares them and the bridge wires the hook automatically.

### `cron` — scheduled

```yaml
trigger:
  type: cron
  schedule: "0 9 * * 1-5"  # weekdays 09:00
```

[node-cron syntax](https://github.com/node-cron/node-cron). Bridge must be running for cron triggers to fire.

### `file_watch` — file save

```yaml
trigger:
  type: file_watch
  patterns:
    - "src/**/*.ts"
    - "src/**/*.tsx"
```

Minimatch globs. Fires on save, not on every keystroke. Cooldown defaults to 5s.

### `git_hook` — git events

```yaml
trigger:
  type: git_hook
  event: post-commit  # or pre-push, post-merge
```

Fires when the corresponding git tool succeeds (`gitCommit`, `gitPush`, `gitPull`). Placeholder vars: `{{hash}}`, `{{branch}}`, `{{message}}`, `{{count}}`, `{{files}}`.

### `manual` — CLI only

```yaml
trigger:
  type: manual
```

Fires only on `patchwork run <recipe-name>`. Useful for one-shots and debug recipes.

---

## Trust + observability

Webhooks don't bypass anything. Specifically:

- **Approval gates still fire.** A webhook recipe that writes to disk or calls a connector still goes through `--approval-gate` if active. Risk-tier escalation works the same way.
- **Trace memory still records.** Every webhook-triggered run lands in `~/.patchwork/runs.jsonl` with the full lifecycle. `patchwork traces export` includes it.
- **The dashboard shows in-flight runs.** Open `http://localhost:3100/runs` to watch a webhook-fired recipe execute step by step.
- **Replay works.** Webhook-fired runs can be mocked-replayed via `POST /runs/:seq/replay` like any other run.

---

## Operational notes

- **Bridge must be running.** Webhooks fail with 503 if the orchestrator isn't up. `patchwork start-all` is the reliable launcher.
- **Public exposure requires `--issuer-url`.** For webhooks from the public internet (iPhone Shortcut over LTE, GitHub Actions, etc.), deploy the bridge with a reverse proxy + TLS and set `--issuer-url` to enable OAuth-bearer auth on the same `/hooks/*` endpoint. Local-network use (`http://192.168.x.x:3100`) doesn't need OAuth — the static bridge token is enough.
- **Multiple recipes, one path.** First match wins; the orchestrator scans `~/.patchwork/recipes/` alphabetically. Keep webhook paths unique.
- **Path namespace:** prefix your hooks (e.g. `/hooks/myname/thought` instead of `/hooks/thought`) if you share a bridge with others or use plugins that ship example recipes.

---

## See also

- [documents/platform-docs.md](platform-docs.md) — full bridge HTTP reference + automation hook list
- [documents/plugin-authoring.md](plugin-authoring.md) — write a tool that the recipe will call
- [documents/live-toolsmithing.md](live-toolsmithing.md) — write that tool *while* the recipe is running
- [documents/architecture.md](architecture.md) — where webhooks fit in the runtime
- [docs/remote-access.md](../docs/remote-access.md) — VPS deployment with `--issuer-url` for public webhook reception
