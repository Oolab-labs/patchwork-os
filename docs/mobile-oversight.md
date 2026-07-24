# Mobile Oversight — Setup Guide

Receive push notifications on your phone when the Patchwork bridge queues a tool call
for approval, and approve or reject it with a single tap — without being at your desk.

---

## How it works

```
Claude Code PreToolUse hook
  → POST /approvals  (bridge)
      → ApprovalQueue (TTL 5 min)
          → dispatchPushNotification  →  push relay  →  FCM / APNS  →  phone
                                                          ↑
                                          approvalToken embedded in payload
Phone taps Approve
  → POST /approve/:callId?token=<approvalToken>  (bridge, phone path)
      → ApprovalQueue.validateToken  →  resolve "approved"
          → hook unblocks, Claude Code proceeds
```

Push notifications arrive in ~2–3 seconds. Approving from the phone unblocks the hook
within 500 ms.

---

## Prerequisites

- Patchwork bridge v0.2.0-alpha.18+ running locally or on a VPS.
- A push path. Pick one:
  - **ntfy.sh** (simplest, recommended for personal use) — free, hosted, action-button approvals straight from the lock screen. No relay infrastructure to run. See [Step 1B](#step-1b--ntfysh-no-relay-needed) below.
  - **Push relay** (FCM/APNS, recommended for teams) — full PWA + service worker integration, custom branding. Self-hosted or hosted at `notify.patchwork.dev`. See [Step 1A](#step-1--deploy-the-push-relay) below.
  - You can also run **both** in parallel; they're independent.
- For the relay path: the dashboard installed as a PWA on your phone (see step 4).
- For the ntfy path: the [ntfy iOS / Android app](https://ntfy.sh/) installed and subscribed to your topic.

---

## Step 1B — ntfy.sh (no relay needed)

Skip this section if you're going with FCM/APNS via the push relay (Step 1 below).

ntfy.sh is a thin pub-sub HTTPS server with iOS/Android apps. The bridge POSTs each pending approval as a notification with two HTTP action buttons (Approve / Reject) that POST back to the bridge with the same single-use token the relay path uses. Tap a button on the lock screen, the approval lands. No FCM, no APNS, no service worker.

1. Pick an unguessable topic. The topic name is your bearer-equivalent — anyone subscribed sees the approval payload and the single-use token.

   ```bash
   openssl rand -hex 6
   # → e.g. d1949fe75b5e — use as the topic suffix
   ```

2. Install the [ntfy app](https://ntfy.sh/) on your phone, open it, **+** → **Subscribe to topic** → enter `patchwork-<your-suffix>`. Leave server as `ntfy.sh` unless you're self-hosting.

3. Configure the bridge. The bridge's `pushServiceBaseUrl` must be a public HTTPS URL the phone can reach (your reverse tunnel / VPS / Cloudflare Tunnel). The action buttons POST to `${pushServiceBaseUrl}/approve/<callId>` with the single-use token in the `x-approval-token` header.

   ```bash
   curl -X POST https://<bridge-public-url>/settings \
     -H "Authorization: Bearer $BRIDGE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "ntfyTopic": "patchwork-d1949fe75b5e",
       "pushServiceBaseUrl": "https://<bridge-public-url>"
     }'
   ```

   Self-hosted ntfy: also pass `"ntfyServer": "https://ntfy.your-domain.tld"`.

4. Test it. Trigger any approval-gated tool call (e.g. a `gitPush` from a Claude Code session). Within seconds your phone buzzes with a notification carrying Approve / Reject buttons. Tap one. The bridge records the decision and unblocks the tool call.

**Security model:** the `pushServiceBaseUrl` must be HTTPS — the bridge refuses to publish ntfy notifications when it's plaintext, because the action URLs would carry the single-use token over the wire. Topic names should be high-entropy (≥ 8 random hex bytes) and rotated if leaked. For multi-recipient or auth-gated topics, run [self-hosted ntfy](https://docs.ntfy.sh/install/) and point `ntfyServer` at it.

**Trade-off vs the relay path:** ntfy is single-recipient (anyone with the topic name receives the push), no PWA, no custom branding. If you need team workflows or per-user device routing, use the relay path below.

---

## Step 1 — Deploy the push relay

### Option A: Self-hosted

```bash
cd services/push-relay
cp .env.example .env
# Edit .env: set RELAY_AUTH_TOKENS, REDIS_URL (optional), FCM_SERVICE_ACCOUNT (optional), APNS_* (optional)
npm install
npm run build
npm start
# Expose via reverse proxy with TLS (nginx, Caddy)
```

The relay listens on `PORT` (default 3001). It must be reachable over HTTPS from the bridge.

### Option B: Hosted (Pro tier)

The relay is hosted at `https://notify.patchwork.dev`. Your `PUSH_RELAY_TOKEN` is issued
when you activate the Pro plan. Skip to step 2.

### FCM setup (Android)

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com).
2. Add an Android app (package `com.patchwork.app`) or use "Web" for the PWA.
3. Download the service account JSON: **Project Settings → Service accounts → Generate new private key**.
4. Set `FCM_SERVICE_ACCOUNT` in the relay `.env` to the JSON contents (one line, escaped).

### APNS setup (iOS)

1. In Apple Developer Portal, create an **APNs Auth Key** (`.p8`).
2. Note the Key ID and Team ID.
3. Set `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` in the relay `.env`.

---

## Step 2 — Configure the bridge

Add to your bridge startup (`.env.vps`, `systemd` environment, or CLI flags):

```bash
# via env vars
export PATCHWORK_PUSH_URL=https://your-relay.example.com
export PATCHWORK_PUSH_TOKEN=your-relay-bearer-token
export PATCHWORK_PUSH_BASE_URL=https://your-bridge-domain.example.com

# or via CLI flags
patchwork start \
  --push-service-url https://your-relay.example.com \
  --push-service-token your-relay-bearer-token \
  --push-service-base-url https://your-bridge-domain.example.com
```

Or set at runtime without restarting — POST to the bridge settings endpoint
(the bridge picks an ephemeral port at startup; read it from the lock file):

```bash
BRIDGE_PORT=$(ls -t ~/.claude/ide/*.lock | head -1 | xargs -I {} basename {} .lock)
curl -X POST "http://localhost:${BRIDGE_PORT}/settings" \
  -H "Authorization: Bearer $(patchwork print-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "pushServiceUrl": "https://your-relay.example.com",
    "pushServiceToken": "your-relay-bearer-token",
    "pushServiceBaseUrl": "https://your-bridge-domain.example.com"
  }'
```

`pushServiceBaseUrl` must be the publicly reachable HTTPS URL of the bridge — the phone
uses it to call back with the approval decision.

---

## Step 3 — Configure the dashboard

Add to `dashboard/.env.local`:

```bash
# Push relay
PUSH_RELAY_URL=https://your-relay.example.com
PUSH_RELAY_TOKEN=your-relay-bearer-token

# VAPID public key — generate once:
#   npx web-push generate-vapid-keys
# Store the private key in the relay; public key goes here and in the relay env.
NEXT_PUBLIC_VAPID_PUBLIC_KEY=BxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA
```

Rebuild and redeploy the dashboard after changing `.env.local`.

---

## Step 4 — Install the dashboard as a PWA

### iOS (Safari)

1. Open `https://your-dashboard.example.com/approvals` in Safari.
2. Tap the **Share** button → **Add to Home Screen**.
3. Tap **Add**. The Patchwork icon appears on your home screen.
4. Open the PWA from the home screen (must be opened from home screen, not browser, for push to work).

### Android (Chrome)

1. Open `https://your-dashboard.example.com/approvals` in Chrome.
2. Tap the three-dot menu → **Add to Home screen** (or the install prompt that appears).
3. Tap **Install**.

---

## Step 5 — Subscribe to push notifications

1. Open the PWA on your phone.
2. Go to **Settings → Mobile notifications**.
3. Tap **Enable push notifications**.
4. Allow the notification permission prompt.
5. Tap **Test notification** to verify delivery (you should see a test push within a few seconds).

---

## Using mobile approvals

When Claude Code queues a tool call:

1. Your phone vibrates and shows a notification: **"⚠️ Approval required — gitPush to origin/main"**.
2. The notification has two inline action buttons: **Approve** and **Reject**.
   - Tapping either resolves the approval directly without opening the PWA.
3. Tapping the notification body opens the PWA to `/approvals?highlight=<callId>`, where you
   can review risk signals and params before deciding.

The approval token embedded in the notification is **single-use** and expires with the queue
entry. The TTL is per risk tier, not a flat window — defaults are 5 min (low), 60 min (medium),
4 hours (high), configurable via `--approval-timeout-<tier>` or the settings dashboard; see
[ADR-0006's risk-tiered timeout amendment](adr/0006-approval-gate-design.md). After expiry, the
call resolves as `"expired"` and does not execute — expiry never auto-approves, regardless of
tier.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| No notification received | `POST /push/test` in settings returns error → relay unreachable from dashboard |
| Notification arrives but approve fails | `pushServiceBaseUrl` not set or wrong — phone can't reach bridge |
| "Push relay not configured" in settings | `PUSH_RELAY_URL` and `PUSH_RELAY_TOKEN` not set in dashboard env |
| iOS: no notification permission prompt | PWA must be opened from home screen icon, not browser |
| "invalid or expired approval token" | Token already used or call expired (>5 min) |
| Push relay `RELAY_AUTH_TOKENS` mismatch | Token in bridge config must match a `token:userId` entry in relay |

---

## Security notes

- **Approval tokens are single-use.** Even if a notification is intercepted, the token cannot
  be replayed after the first approve/reject.
- **Tokens expire.** Default TTL is 5 minutes. Configure with `--ttl-ms` on the bridge.
- **The bridge bearer token is never sent to the phone.** The phone only ever sees the
  per-callId approval token delivered via push.
- **Push relay sees approval tokens.** Use TLS between bridge and relay, and between relay and
  FCM/APNS. For maximum isolation, self-host the relay on infra you control.
- **VAPID keys** authenticate the Web Push subscription. Keep the private key on the relay;
  the public key is safe to publish.
