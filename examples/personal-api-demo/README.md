# Patchwork Personal API — Demo PWA

A minimal single-page web app demonstrating how to build a private application
against your own Patchwork OS bridge using **OAuth 2.0 with PKCE**.

## What it demonstrates

- **Dynamic client registration** (RFC 7591) — the app self-registers with the bridge, no manual client setup
- **Authorization Code + PKCE** (S256, RFC 7636) — no client secret needed, safe in the browser
- **Bearer token API calls** — listing recipes, triggering a run, responding to approvals
- **Raw API explorer** — send any authenticated request to the bridge

## Prerequisites

1. A running Patchwork OS bridge started with `--issuer-url`:

   ```bash
   claude-ide-bridge --full \
     --issuer-url https://bridge.example.com \
     --cors-origin https://your-app-origin.com
   ```

   For local development:

   ```bash
   claude-ide-bridge --full \
     --issuer-url http://localhost:3100 \
     --cors-origin http://localhost:8080
   ```

2. Serve this directory over HTTP (required for the OAuth redirect URI):

   ```bash
   cd examples/personal-api-demo
   npx serve .      # serves at http://localhost:3000
   # or
   python3 -m http.server 8080
   ```

3. Open `http://localhost:3000` (or whichever port), enter your bridge URL, and click **Connect & Sign in**.

## How the auth flow works

```
Browser                          Bridge
   │                               │
   │  POST /oauth/register         │   ← dynamic client registration
   │ ────────────────────────────► │
   │  ← { client_id }             │
   │                               │
   │  GET /oauth/authorize         │   ← PKCE code_challenge (S256)
   │ ────────────────────────────► │
   │         [bridge approval page — user enters bridge token]
   │  ← 302 ?code=…&state=…       │
   │                               │
   │  POST /oauth/token            │   ← code + code_verifier
   │ ────────────────────────────► │
   │  ← { access_token }          │
   │                               │
   │  GET /recipes                 │   ← Bearer <access_token>
   │ ────────────────────────────► │
```

## Adapting this for your own app

- Replace the recipe list + run UI with your own workflow
- The bearer token works with every bridge API endpoint
- Token TTL is 24 hours; re-authenticate when the token expires (the app will show an auth error)
- For production, always use HTTPS and set `--cors-origin` to your app's exact origin
