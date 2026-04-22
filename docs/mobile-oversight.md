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
- A push relay service reachable from the bridge (self-hosted or hosted at `notify.patchwork.dev`).
- The dashboard installed as a PWA on your phone (see step 4).

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

Or set at runtime without restarting — POST to the bridge settings endpoint:

```bash
curl -X POST http://localhost:3100/settings \
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
TTL (default 5 minutes). After expiry, the call is automatically rejected.

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
