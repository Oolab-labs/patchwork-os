# Push relay — data flow

What leaves your machine when you enable mobile approvals, who can see it, and
how long it is kept.

Everything below is read from the source (`services/push-relay/src/`,
`src/approvalHttp.ts`) rather than from design intent. Where the answer is
operational rather than in the code — retention policy on a deployed Redis, who
runs a hosted instance — it is marked `TODO(owner):` instead of guessed.

Companion to [privacy-policy.md](privacy-policy.md), which covers the local and
remote-mode paths.

---

## 1. The path

Mobile approvals are **off unless configured**. With no `pushServiceUrl` in
`~/.patchwork/config.json`, none of this runs and nothing leaves the machine.
See §7 — the setting is a config key, not an environment variable.

```
  ┌────────────────────┐
  │ your machine       │   an approval is queued
  │                    │   (risky tool call, worker gate, …)
  │   bridge           │
  │   approvalQueue    │
  └─────────┬──────────┘
            │  POST https://<relay>/push
            │  Authorization: Bearer <pushServiceToken>
            │  body: callId, toolName, tier, summary,
            │        requestedAt, expiresAt, approvalToken,
            │        bridgeCallbackBase, riskSignals
            ▼
  ┌────────────────────┐
  │ push relay         │   looks up YOUR registered devices by userId
  │ (self-hosted or    │   (the bearer token maps token → userId)
  │  the dashboard's   │
  │  /api/relay/push)  │   drops riskSignals; forwards the rest
  └────┬──────────┬────┘
       │          │
       │ FCM      │ APNS
       ▼          ▼
  ┌─────────┐ ┌─────────┐
  │ Google  │ │ Apple   │   sees title, body, and the whole data dict
  └────┬────┘ └────┬────┘   — including approvalToken
       │           │
       └─────┬─────┘
             ▼
     ┌───────────────┐
     │ your phone    │   taps "Approve"
     └───────┬───────┘
             │  POST <bridgeCallbackBase>/approve/<callId>
             │  x-approval-token: <approvalToken>
             │
             │  ⚠ this goes DIRECTLY to your bridge.
             ▼     It does NOT pass back through the relay.
  ┌────────────────────┐
  │ your machine       │
  │   bridge           │   single-use token; the action runs
  └────────────────────┘
```

The return path is the important shape: **the decision does not travel through
the relay.** The phone posts to `bridgeCallbackBase` — your own bridge, reached
over whatever tunnel or reverse proxy you configured. The relay is a one-way
notification fan-out.

---

## 2. Every field in the payload

Sent by `dispatchPushNotification` (`src/approvalHttp.ts`), received by
`POST /push` (`services/push-relay/src/routes.ts`), forwarded to devices by
`dispatchToUser` (`.../dispatcher.ts`).

| Field | Why it exists | Reaches the phone? | Reaches Apple/Google? |
|---|---|---|---|
| `callId` | Correlates the tap back to the queued approval. Without it the phone cannot say *which* decision it is answering. | Yes | Yes |
| `toolName` | What would run. Used as the notification body when there is no summary. | Yes | Yes |
| `tier` | `low`/`medium`/`high`. Drives the ⚠️ prefix on the title, so urgency survives a glance at a lock screen. | Yes | Yes |
| `summary` | The human sentence — *"Push the release branch"*, *"Errands (issue:compensable:high): reversible…"*. **This is the field that carries real content.** Optional; without it the body falls back to `Tool: <toolName>`. | Yes | Yes |
| `requestedAt` | When it was queued, so the phone can show age. | Yes | Yes |
| `expiresAt` | When the approval stops being valid. Lets the phone grey out a dead card instead of offering a button that will fail. Clamped by the relay — see §5. | Yes | Yes |
| `approvalToken` | The single-use bearer the phone presents to your bridge. **Never placed in a URL** — only in the FCM `data` / APNS `payload` dict, so it cannot land in an access log, a `Referer`, or browser history. | Yes | Yes |
| `bridgeCallbackBase` | Where the phone sends the decision. Composed into `approveUrl`/`rejectUrl` by the dispatcher. | Yes | Yes |
| `riskSignals` | Sent by the bridge, **dropped by the relay.** `routes.ts` rebuilds the payload field-by-field and does not copy it, so risk detail never reaches a device or a push provider. | No | No |

That last row is worth stating plainly because it is the one place the relay
narrows what it was given rather than passing it through.

---

## 3. What the relay can and cannot see

**Can see, in plaintext:**

- The `summary` — so **yes, the relay can read approval contents.** If the
  summary describes what an agent is about to do, the relay operator can read
  that. There is no end-to-end encryption between bridge and phone.
- The `approvalToken` and `bridgeCallbackBase`.

**Cannot see:**

- Anything not in the payload: your files, your repo, tool arguments, the
  agent's reasoning, the result of the action. The relay never connects to your
  bridge and has no read path into it.
- Your decision. Approve/reject goes phone → bridge directly (§1).

**Could a compromised relay approve something on your behalf?**

Yes — and this should not be soft-pedalled. The payload contains a valid
`approvalToken` and the `bridgeCallbackBase` to spend it against. A relay that
is compromised, or an operator who is dishonest, has everything needed to
approve an action instead of you, provided it can reach your bridge's callback
URL. What limits the damage:

- The token is **single-use** and short-lived (§5), so it buys one action, once.
- It only works for approvals **already queued** by your bridge. A relay cannot
  originate an action, only answer one.
- The blast radius is exactly the action that was queued — which the gate
  already judged risky enough to ask about.

The mitigation is deployment, not code: run your own relay, or use the
dashboard's Web Push route on infrastructure you control. See §6.

**A note on Apple and Google.** APNS and FCM payloads are not end-to-end
encrypted. Both providers can see the notification title, the body (your
`summary`), and the entire data dictionary — **including `approvalToken`**.
Keeping the token out of the *URL* protects it from logs and referrers; it does
not hide it from the push provider. If that matters for your threat model, do
not enable mobile approvals.

---

## 4. Retention

**Device registrations**

| Store | Lifetime |
|---|---|
| `InMemoryRegistry` (no `REDIS_URL`) | Process lifetime. Lost on restart. |
| `RedisRegistry` (`REDIS_URL` set) | **Indefinite.** `register()` calls `hSet` with no `EXPIRE` anywhere in `deviceRegistry.ts`. A registration persists until the device is explicitly removed (`DELETE /devices`) or evicted by the 10-device-per-user cap, which drops the oldest by `registeredAt`. |

A device record is `{ token, platform, registeredAt }` — the push token, whether
it is FCM or APNS, and a timestamp. No account data, no device name, no IP.

**Payloads**

Not persisted at all. `dispatchToUser` is fire-and-forget; nothing is written to
Redis or disk. The only residue is the replay table: a `Map` of
`callId:approvalToken → expiry`, in memory, entries living 15 minutes, capped at
10 000. It stores the token as a map *key* for duplicate detection and is lost
on restart.

**Logs**

`logErrorSafe` (`redact.ts`) strips PEM blocks and any base64-ish run of ≥40
characters before anything reaches stderr, so a botched credential parse cannot
print the credential. Normal request logging is Express default (method, path,
status) — no bodies.

> `TODO(owner):` Is there a retention policy on the deployed Redis (maxmemory
> policy, backup schedule, TTL applied outside the application code)? The code
> sets none, so "indefinite" is the honest answer for the store as written.
>
> `TODO(owner):` Are relay access logs retained anywhere — reverse proxy, Cloud
> Run request logs, host syslog — and for how long? They would contain the
> authenticated `userId` and request timing, though not payload bodies.
>
> `TODO(owner):` Is a hosted relay operated for users at all, and by which
> entity? `auth.ts` refers to tokens "issued at Pro signup", which implies a
> hosted plan that may or may not exist yet. If none is operated, say so
> explicitly here — it is a meaningful privacy answer.

---

## 5. Hardening, as implemented

Each item below is a specific behaviour in the code, not a claim of intent.

**Authentication** (`auth.ts`)
Bearer token required on every route except `/health`. Tokens are **never held
in plaintext**: at construction the process generates a random 32-byte HMAC key
and stores `HMAC-SHA256(key, token)`; a lookup rehashes the presented token and
compares digests with `timingSafeEqual`. A heap dump yields digests, not
credentials. The token also *is* the identity — it maps to the `userId` whose
devices receive the fan-out.

**Bridge-side egress guard** (`src/approvalHttp.ts`)
The bridge refuses to send unless `pushServiceUrl` is `https://`, rejects
`localhost`, and runs the same SSRF resolution guard used for webhooks
(`hostResolvesToBlockedIp`). Private and CGNAT ranges are blocked unless
explicitly opted in — the opt-in exists for operators pointing at a Tailscale or
VPN host they control. 5-second timeout, fire-and-forget: a dead relay never
blocks or delays an approval.

**Replay protection** (`routes.ts`)
Single-use per `(callId, approvalToken)` pair within a 15-minute window; a repeat
gets `409`. Keyed on both values together, never either alone. When the table is
at its 10 000-entry cap it prunes expired entries and, if still full, returns
`503` rather than evicting unexpired ones — refusing service instead of quietly
re-opening a replay window under load.

**Expiry clamp** (`routes.ts`)
A caller-supplied `expiresAt` is clamped to now+5 min by default and hard-capped
at now+15 min. Without this a payload claiming a ten-year expiry would be
honoured by phone clients indefinitely. Already-expired payloads are rejected
`400`.

**Body size** (`index.ts`)
`express.json({ limit: "16kb" })`. Push payloads are tiny; the cap sheds
memory-amplification attempts at the parser.

**Rate limiting** (`index.ts`, `routes.ts`)
Per-IP: 60 requests/minute, applied **after** the auth gate so unauthenticated
requests are rejected before they can consume anyone's bucket. Per-user:
5 device registrations/minute — without it, a leaked bearer token could churn
registrations and evict the legitimate device on every cycle.

**Device cap** (`deviceRegistry.ts`)
10 devices per user, oldest evicted, so a leaked token cannot grow a user's
device hash without bound.

**Other**
`helmet()` for standard headers. No CORS headers at all — server-to-server only,
no browser callers. Request/header timeouts (10s/11s) so a slow client cannot pin
a worker. `FCM_SERVICE_ACCOUNT` and `APNS_KEY` are `delete`d from `process.env`
after parsing so they do not linger for child processes or dumps. `/health` is
mounted before auth for uptime probes and returns only `{ok:true}` — deliberately
not reporting which providers are configured, which would leak deployment shape
to unauthenticated callers.

---

## 6. Self-hosting

Yes, and it is the intended deployment. There are two implementations of the
same wire shape; **run one, never both** — pointing a bridge at both double-fires
every approval.

**A. The standalone relay** (`services/push-relay/`) — native FCM/APNS.
Independent Node service with its own `package.json`; the bridge talks to it only
over HTTP.

```bash
cd services/push-relay
cp .env.example .env      # set RELAY_AUTH_TOKENS at minimum
npm install && npm run build && npm start
```

Configuration is entirely env vars: `RELAY_AUTH_TOKENS` (`token:userId,…`),
optional `REDIS_URL` (in-memory without it), and the FCM/APNS credentials. It
needs a Firebase service account and/or an APNS key — i.e. you must own the
mobile app identity.

**B. The dashboard's routes** — Web Push to a browser/PWA subscription, no
Apple/Google app credentials needed. `dashboard/src/app/api/relay/{push,halt}`
implement the same `POST /push` + Bearer shape. This is the path the project
itself dogfoods; see [mobile-oversight-self-host.md](mobile-oversight-self-host.md).

Point the bridge at whichever you chose by setting `pushServiceUrl` and
`pushServiceToken` — see §7 for where those actually live.

---

## 7. Configuration, and turning it off

**Where the setting lives.** This is easy to get wrong, so it is worth being
exact. There are two different sets of names on the two sides of the wire:

| Side | Setting | Where |
|---|---|---|
| **Bridge** (sender) | `pushServiceUrl`, `pushServiceToken`, `pushServiceBaseUrl` | Keys in `~/.patchwork/config.json`, read by `loadPatchworkConfig` (`src/config.ts`). Writable from the dashboard's Settings → Mobile card. **Not** environment variables — the bridge reads no `PATCHWORK_PUSH_*` var. |
| **Dashboard relay** (receiver, option B) | `PATCHWORK_PUSH_TOKEN`, `PATCHWORK_PUSH_URL`, `PATCHWORK_PUSH_BASE_URL` | Environment variables for the Next.js process, used to authenticate inbound `/api/relay/*` requests. |
| **Standalone relay** (receiver, option A) | `RELAY_AUTH_TOKENS`, `REDIS_URL`, `FCM_*`, `APNS_*` | Environment variables for that service. |

So unsetting `PATCHWORK_PUSH_URL` does **not** disable push on a bridge
configured through `config.json` or the dashboard. That is the mistake this
table exists to prevent.

**Mobile approvals are off by default.** To have none of this happen:

- Leave `pushServiceUrl` unset in `~/.patchwork/config.json`. The dispatch is
  guarded by `if (deps.pushServiceUrl && deps.pushServiceToken && approvalToken)`
  (`src/approvalHttp.ts:944`) — with no URL, no request is made and no code path
  runs.
- Already enabled? Clear `pushServiceUrl` and `pushServiceToken` from
  `~/.patchwork/config.json` (or blank the fields in Settings → Mobile) and
  restart the bridge.
- To stop one device rather than the whole path: `DELETE /devices` with the
  token in the JSON body, or the dashboard settings card.
- To stop everything acting, not just the phone path: `patchwork panic`
  (see [ADR-0013](adr/0013-kill-switch.md)).

Approvals continue to work normally without push — the queue, the dashboard and
the CLI are unaffected. Push is a notification channel, never the gate itself.

---

## 8. Known gap

**Cancel notifications are not dismissed by the standalone relay.**

When a pending approval resolves some other way — the gate is downgraded to
`off`, or the bridge shuts down — `dispatchCancelPush` POSTs
`{ kind: "cancel", callId }` to `/push` so the phone can drop a card that is now
moot. The standalone relay's `/push` handler requires `callId`, `toolName`,
`tier` **and** `approvalToken`; a cancel body carries only the first, so it is
rejected `400`. The dispatch is fire-and-forget and only logs a warning, so the
failure is silent and the notification stays on the lock screen.

The dashboard's `/api/relay/push` **does** handle `kind: "cancel"`
(`route.ts:95`), so this is a parity gap between the two implementations rather
than a missing design.

Consequence is a stale card, not an unsafe one: tapping it spends a token that
is single-use and already expired or cancelled, so the bridge refuses it. Fixing
it means teaching the standalone relay's `/push` the cancel shape before the
required-field guard.

Not fixed here — this pass documents behaviour rather than changing it.
