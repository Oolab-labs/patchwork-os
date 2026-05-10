# Sending recipe output to your phone

You will eventually want a recipe to ping your phone — a daily brief, a "this PR is ready for review" nudge, a tweet draft to approve. This doc walks through the path that works and the dead ends to skip.

## TL;DR

Use **[ntfy.sh](https://ntfy.sh)**, not iMessage. One `curl POST` from any recipe step lands as a push on your phone with optional action buttons. No signing, no permissions, no platform-specific code paths.

```yaml
- id: push-to-phone
  agent:
    driver: claude-code
    tools: [Bash]
    prompt: |
      Run EXACTLY:
      curl -fsS -X POST \
        -H "Title: Daily brief" \
        -d "Three PRs need review" \
        https://ntfy.sh/<your-unguessable-topic>
```

Pick a long random topic (`openssl rand -hex 6` is enough — topics are unauthenticated by default; treat the topic name as the secret). Install the ntfy app on iOS or Android, subscribe to the topic, done.

## Why not iMessage / AppleScript

This is the path most people try first. It looks like five lines of AppleScript. It does not work reliably from a recipe.

The blocker is macOS TCC (Transparency, Consent, Control). When a process tries to send AppleEvents to Messages.app, TCC checks the **responsible process** — not the immediate caller, but the bundle identity at the top of the spawn chain. For a recipe step, that chain is:

```
launchd → patchwork bridge (node) → claude CLI → osascript → Messages.app
```

`launchd` is the responsible process. It is not in System Settings → Privacy & Security → Automation, and macOS will not prompt for it. The AppleEvent is denied silently — `osascript` exits 0, no error reaches the recipe, no message is delivered. From an interactive Terminal session the same script works fine, because Terminal.app is the responsible process and TCC knows about it.

We tried the obvious workarounds:

- **Custom `SendIMessage.app` helper with a stable bundle ID.** Modern macOS (Sequoia 15+) pins TCC grants to `(bundle ID, code-signing-identity-hash)`. Ad-hoc signatures hash to the binary's CDHash, which changes on every rebuild — so the grant invalidates. You need a real Developer ID team identifier, which means a paid Apple Developer account and notarization for every helper update. Not viable for a personal automation.
- **Apple Shortcuts via `shortcuts run`.** Same TCC chain, plus the Send Message action prompts for confirmation in many configurations. Unreliable.
- **Re-bootstrapping the bridge LaunchAgent into the GUI session** (`launchctl bootstrap gui/$UID`). Helps for some Aqua-only services but does not change Automation→Messages — TCC still demands a Developer-ID-signed responsible process.

If you absolutely need iMessage delivery and accept the limitations, the only path that works without a paid Developer ID is running the bridge inside Terminal.app via a Login Item (a `.command` script that backgrounds the bridge in tmux/screen). Terminal then becomes the responsible process. You lose headless-after-reboot recovery.

## Why ntfy

ntfy is a thin pub-sub HTTP server. The recipe POSTs a message; the iOS/Android app receives a push. Architecture-wise it sidesteps every TCC question because no AppleEvent is involved.

Practical advantages over iMessage for recipe output:

- **Works from any spawn context.** LaunchAgent, cron, ssh, bridge subprocess — anywhere `curl` can reach the public internet.
- **Action buttons.** Up to three buttons per notification, either `view` (opens a URL) or `http` (POSTs/PUTs back to a URL — true round-trip into your bridge).
- **Tags, priorities, click URLs, attachments.** A `Click` header makes the entire notification tap-to-open-URL.
- **Self-hostable.** If you outgrow the public ntfy.sh server, the same `curl` URL pattern points at your own deployment.

Limitations to know about:

- The public `ntfy.sh` topic namespace is shared. Use a long random topic name; treat it like a bearer token.
- Public ntfy keeps messages for 12h by default. For longer retention or auth, self-host.
- iOS app uses Apple Push Notification Service, so deep-background reliability matches anything else on iOS.

## Action buttons (round-trip approval)

For approve/reject style flows where tapping a button should land state back on the bridge, use the JSON publish form (avoids HTTP-header encoding issues with non-ASCII content) and `http` actions:

```bash
curl -X POST https://ntfy.sh/ \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "your-topic",
    "title": "Approve tool call?",
    "message": "Agent wants to run rm -rf node_modules in three repos.",
    "actions": [
      {
        "action": "http",
        "label": "Approve",
        "url": "https://bridge.example.com/approvals/abc123/approve",
        "method": "POST",
        "headers": { "Authorization": "Bearer <bridge-token>" }
      },
      {
        "action": "http",
        "label": "Reject",
        "url": "https://bridge.example.com/approvals/abc123/reject",
        "method": "POST",
        "headers": { "Authorization": "Bearer <bridge-token>" }
      }
    ]
  }'
```

The bridge endpoint is whatever your reverse tunnel exposes (see [docs/remote-access.md](remote-access.md)). Use a short-lived approval token in the URL path so a leaked notification doesn't grant indefinite access.

## Header encoding gotcha

ntfy supports two publish forms: header-based (`-H "Title: ..."` against `https://ntfy.sh/<topic>`) and JSON (`POST https://ntfy.sh/` with `{"topic": ..., "title": ...}`). HTTP headers are latin-1 only — em-dashes, smart quotes, emoji in titles or messages will fail. Use the JSON form whenever the content is not pure ASCII. Use the header form for one-off scripts where you control the content.

## Working example

[`oolabs-daily-tweets.yaml`](../examples/recipes/oolabs-daily-tweets.yaml) drafts three tweets from recent merged PRs and pushes them to the user's phone via ntfy with a `Click: https://x.com/compose/tweet` header so tapping the notification opens X compose. The push step is a single `curl` against the topic — the entire path from `patchwork recipe run` to phone-buzz is under five seconds after the agent step completes.
