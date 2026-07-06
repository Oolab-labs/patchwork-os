# push-relay

Standalone Express service that lets the bridge notify a phone when an approval is queued, without exposing the bridge itself to the public internet. The bridge POSTs an approval payload (`callId`, `toolName`, `tier`, `approvalToken`, ...) to `POST /push`; the relay looks up the requesting user's registered devices and fans the notification out via FCM (Android) and/or APNS (iOS). It is the implementation referenced by ADR-0006's phone-path design and by `PATCHWORK_PUSH_URL`/`PATCHWORK_PUSH_TOKEN` in the root CLAUDE.md.

It is a sibling, not a dependency, of `dashboard/src/app/api/relay/push` and `.../relay/halt`: those two dashboard routes implement the same wire shape (`POST /push`, Bearer auth against a shared token) but fan out via Web Push to browser subscriptions instead of native FCM/APNS. An operator points `pushServiceUrl` at either this service or the dashboard's own URL — never both.

## The files that matter

- `src/index.ts` — entrypoint. Wires up Redis-or-in-memory device registry, optional FCM (`firebase-admin`) and APNS (`@parse/node-apn`) adapters from env, mounts `/health` (unauthenticated, for uptime probes) ahead of the bearer-auth gate, then the per-IP rate limiter, then the router.
- `src/auth.ts` — `EnvTokenStore`: parses `RELAY_AUTH_TOKENS` ("token:userId,...") but never retains tokens in plaintext — each is HMAC-SHA256'd with a random per-process key at construction, and lookup rehashes the inbound token and compares digests with `timingSafeEqual`. This is the auth correctness core of the whole service.
- `src/routes.ts` — the five endpoints (`/push`, `/devices/register`, `DELETE /devices`, `/devices/count`, `/push/test`). Owns the replay-defense table (single-use per `callId:approvalToken` within a 15-min window, capped at 10k entries) and the `expiresAt` clamp (default +5min, hard cap +15min) so a captured payload can't be replayed or held open indefinitely.
- `src/dispatcher.ts` — `dispatchToUser`: fans a payload out to all of a user's FCM/APNS devices in parallel, swallowing per-device errors so one bad token doesn't block the batch. Puts `approvalToken` only in the FCM/APNS `data` payload, never in the approve/reject URL, so it never lands in access logs or Referer headers.
- `src/deviceRegistry.ts` — `InMemoryRegistry` (dev/test) and `RedisRegistry` (prod), the latter capping devices per user at 10 with oldest-eviction so a leaked bearer token can't unbounded-grow a user's device hash.
- `src/redact.ts` — `logErrorSafe`: strips PEM blocks and long base64-ish runs from anything written to stderr, so a botched `FCM_SERVICE_ACCOUNT`/`APNS_KEY` parse failure can't leak the credential into logs.

That's the whole `src/`, seven files — genuinely small; nothing above is padding.

## Invariants you must not break

- **Token comparison is HMAC-then-`timingSafeEqual`, never plain `===`** (`auth.ts`). Tokens are never stored as plaintext at rest — a heap dump only exposes digests.
- **`approvalToken` must never appear in a URL** (query string or path) — only in the push payload's `data`/`payload` body. The dispatcher and the mobile client both rely on this to keep tokens out of access logs.
- **Replay defense is keyed on `(callId, approvalToken)` together**, not either alone, and the table must fail closed (503) rather than silently evicting unexpired entries when at capacity — never re-open a replay window under load.
- **This is a standalone deployment**, not a bridge subprocess: own `package.json`/`tsconfig.json`/`vitest.config.ts`, started independently (`npm start` after `npm run build`, or `npm run dev` via `tsx watch`), configured entirely through env vars (`.env.example`). The bridge talks to it only over HTTP via `pushServiceUrl`/`pushServiceToken` — there is no in-process coupling.
- **Never both relays at once** for the same bridge: `pushServiceUrl` should point at either this service or the dashboard's `/api/relay/push`+`/api/relay/halt`, not both, or approvals double-fire.
- **`RELAY_AUTH_TOKENS`, `FCM_SERVICE_ACCOUNT`, `APNS_KEY`** are credential material — `index.ts` explicitly `delete`s the parsed env vars after use so they don't linger in `process.env` for child processes or dumps to find.

## How to test it

```
cd services/push-relay
npm test
```

Runs `vitest run` (config: `vitest.config.ts`, node environment). All tests live in `src/__tests__/relay.test.ts` — auth (rejection, token hashing, no-plaintext-retention), body-size cap, device register/remove/rate-limit, `POST /push` (fire-and-forget 200, FCM field shape, missing-field rejection, replay 409, expiry clamp, expired-payload rejection, replay-table-full 503), and `redactSecrets`.
