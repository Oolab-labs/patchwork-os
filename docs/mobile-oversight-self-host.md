# Mobile Oversight — Self-Hosted Dogfood

How to wire phone notifications + tap-to-approve end-to-end against a
laptop bridge through your own VPS, without running the standalone
`services/push-relay/` (FCM/APNS) process. The dashboard's
`/api/relay/push` route acts as a drop-in for the relay; phone Web Push
+ VAPID delivers the notification; an SSH reverse tunnel routes the
phone's tap back to the laptop bridge.

This is the path the project itself uses for L4 dogfood. For the hosted
multi-tenant FCM/APNS path, see [mobile-oversight.md](mobile-oversight.md).

## Architecture

```
   ┌─────────┐    ┌──────────────────┐
   │ phone   │    │ public domain    │
   │  PWA    │←───│ bridge.your.tld  │
   └─────────┘    └────────┬─────────┘
        ↑                  │ nginx, TLS
        │ web-push (VAPID) │
        │                  ↓
        │           ┌──────┴───────┐
        │           │ VPS          │
        │           │              │
        │           │ next-server  │ ← /dashboard/* → port 3200 (PM2)
        │           │              │     /api/relay/push (web-push fan-out)
        │           │              │     /api/push/{subscribe,test,vapid-key}
        │           │              │
        │           │ sshd         │ ← /approve/<id>, /reject/<id>, /health
        │           │   :3285 ←────┼── reverse-tunnel
        └───push────┘              │
                    └──────────────┘
                                          tunnel from
                                          laptop:<bridge-port>
                                          to VPS:3285
                    ┌──────────────┐
                    │ laptop       │
                    │              │
                    │ bridge       │ ← node tsx src/index.ts
                    │   :63906     │   (port assigned per launch)
                    └──────────────┘
```

Push dispatch path (bridge → phone):
1. Bridge enqueues approval, generates one-shot `approvalToken`
2. Bridge fetches `${pushServiceUrl}/push` with the bearer + payload
3. Dashboard `/api/relay/push` validates bearer, fans out via web-push
4. Service worker on phone receives push, shows notification

Tap path (phone → bridge):
1. User taps notification body → PWA opens `/dashboard/approvals?highlight=<id>`
2. User taps Approve in the dashboard UI
3. Dashboard's bridge proxy (`/dashboard/api/bridge/approve/<id>`) forwards
4. nginx on VPS: `location /` regex match → `127.0.0.1:3285`
5. SSH reverse tunnel: VPS:3285 → laptop:bridge-port
6. Bridge resolves the queue entry, original `POST /approvals` returns

## Prerequisites

- A domain you control with DNS pointing at your VPS public IP. **NOT**
  proxied through any CDN that auto-redirects to HTTPS — Let's Encrypt
  HTTP-01 challenge breaks behind that. Use a direct A record, or use
  the DNS-01 challenge.
- Root SSH access to the VPS.
- nginx + certbot installed on the VPS.
- Node.js + PM2 on the VPS for the dashboard standalone build.
- A laptop with the bridge running locally (`npm run dev` from this repo).

## Setup

### 1. Issue a TLS cert for your bridge domain

If your DNS is on a registrar that runs an edge proxy (Cloudflare,
StableServer, etc.), the HTTP-01 challenge will go through the proxy and
likely fail with HTTP→HTTPS redirects. Use DNS-01 instead:

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d bridge.your.tld --agree-tos -m you@example.com
```

Add the printed TXT record to your DNS panel under
`_acme-challenge.bridge.your.tld`. Wait for propagation (verify with
`dig @1.1.1.1 +short TXT _acme-challenge.bridge.your.tld`), then press
Enter in certbot.

### 2. Configure nginx

Create `/etc/nginx/sites-available/bridge-dogfood`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name bridge.your.tld;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name bridge.your.tld;

    ssl_certificate     /etc/letsencrypt/live/bridge.your.tld/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.your.tld/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /dashboard/api/bridge/stream {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        add_header X-Accel-Buffering no;
    }

    location /dashboard {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Bridge: /approve/<id>, /reject/<id>, /health, etc.
    # Routes to a port the SSH reverse tunnel forwards to your laptop.
    location / {
        proxy_pass http://127.0.0.1:3285;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Symlink + reload:

```bash
sudo ln -sf /etc/nginx/sites-available/bridge-dogfood /etc/nginx/sites-enabled/bridge-dogfood
sudo nginx -t && sudo systemctl reload nginx
```

### 3. Configure the dashboard

In `dashboard/.env.local`:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<from `npx web-push generate-vapid-keys`>
VAPID_PRIVATE_KEY=<same>
VAPID_SUBJECT=mailto:you@example.com
PATCHWORK_PUSH_TOKEN=<random uuid — must match bridge pushServiceToken>
```

Deploy the dashboard to the VPS:

```bash
PATCHWORK_BRIDGE_TOKEN="<your laptop bridge auth token>" bash deploy/deploy-dashboard.sh
```

The deploy script preserves `.env.local` across runs, but its default
template doesn't include VAPID keys or `PATCHWORK_PUSH_TOKEN` — append
them manually after first deploy:

```bash
scp dashboard/.env.local root@vps:/tmp/dash.env
ssh root@vps "
  ENV=/opt/patchwork-dashboard/.env.local
  grep -E '^(NEXT_PUBLIC_VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY|PATCHWORK_PUSH_TOKEN)=' /tmp/dash.env >> \$ENV
  rm /tmp/dash.env
  pm2 restart patchwork-dashboard --update-env
"
```

### 4. Configure the bridge

POST to the bridge's `/settings` endpoint (the bridge runs on your laptop):

```bash
curl -X POST http://127.0.0.1:<bridge-port>/settings \
  -H "Authorization: Bearer $(jq -r .authToken ~/.claude/ide/<bridge-port>.lock)" \
  -H "Content-Type: application/json" \
  -d '{
    "pushServiceUrl":     "https://bridge.your.tld/dashboard/api/relay",
    "pushServiceToken":   "<same PATCHWORK_PUSH_TOKEN as on dashboard>",
    "pushServiceBaseUrl": "https://bridge.your.tld"
  }'
```

Also add `"https://bridge.your.tld"` to the bridge's `corsOrigins` so
phone-tap requests aren't rejected by the Host-validation defense:

```bash
jq '.corsOrigins = ["https://bridge.your.tld"]' \
   ~/.claude/ide/config.json > /tmp/cfg && mv /tmp/cfg ~/.claude/ide/config.json
```

The change takes effect on next bridge restart.

### 5. Open the SSH reverse tunnel

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:3285:localhost:<bridge-port> \
  root@<vps-ip>
```

Leave running. If the bridge restarts and gets a new port, reconnect
the tunnel.

### 6. Install the PWA on your phone

On iOS Safari 16.4+ in a regular (NOT Private) tab, navigate to
`https://bridge.your.tld/dashboard/settings`, tap Share → Add to Home
Screen → Add. **Open the PWA from the home-screen icon** — Web Push only
works in installed-PWA mode on iOS, not in a Safari tab.

In the PWA: Settings → Mobile → Subscribe to push → grant permission.
Tap Send test notification — your phone should buzz within ~3s.

### 7. Trigger a real approval

Set the bridge gate to `high` (or `all`):

```bash
curl -X POST http://127.0.0.1:<bridge-port>/settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"approvalGate":"high"}'
```

From any Claude Code session connected to your laptop bridge, run a
high-tier tool. The bridge will queue an approval, dispatch a push, and
your phone will notify within ~3 s. Tap the notification → PWA opens to
the approvals page → tap Approve → bridge unblocks the tool.

## Gotchas

- **iOS notification action buttons are flaky.** Apple's WebKit
  partially implements them. Body-tap (which opens the PWA) is the
  reliable interaction.
- **`/etc/hosts` overrides DNS.** If your laptop has a leftover entry
  for `bridge.your.tld` from earlier setup, the bridge's outbound push
  goes to the wrong IP and silently 502s. Check with
  `grep bridge /etc/hosts`.
- **Bridge port rotates.** When the bridge restarts (Windsurf reload,
  laptop reboot, etc.) it picks a new port. The lock file path changes
  to match. Re-establish the SSH tunnel with the new port and re-POST
  the bridge `/settings` since the in-memory `pushServiceUrl/Token/BaseUrl`
  is lost on restart.
- **Subscriptions invalidate on SW updates.** With the
  `pushsubscriptionchange` handler the SW re-subscribes automatically,
  but iOS-side reliability is mixed. If notifications stop after a
  dashboard deploy, force-close + reopen the PWA + tap Subscribe again.
- **`PATCHWORK_BRIDGE_TOKEN=REPLACE_ME` on VPS.** If the dashboard is
  deployed without the env var set on the local shell at deploy time,
  the heredoc previously substituted `REPLACE_ME`. Fixed in
  `deploy-dashboard.sh` (passes via positional args). If you hit it on
  an older copy, scp the right value into `/opt/patchwork-dashboard/.env.local`
  manually.
- **Edge proxies break HTTP-01.** If your DNS provider runs an edge
  proxy that auto-redirects to HTTPS, certbot's `--nginx` and
  `--webroot` paths both fail. Use `--manual --preferred-challenges dns`.
- **Production bridge already on :3284.** This repo's deploy script
  runs the production bridge on `127.0.0.1:3284`. Don't tunnel into
  that port — pick :3285 for the dogfood reverse tunnel and update
  nginx accordingly. Otherwise SSH binds IPv6-only and nginx hits the
  production bridge instead of your laptop.
