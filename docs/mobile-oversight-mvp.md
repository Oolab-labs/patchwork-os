# Mobile Oversight MVP — Agent Plan

**Goal:** Let a user approve/reject pending tool calls from their phone, with push notifications
that alert them within seconds of a request being queued.

Produced by multi-agent review of codebase state (v2.30.1 · 2026-04-22).

---

## Context

The approval infrastructure already exists and is solid:

- `src/approvalQueue.ts` — in-memory queue with TTL, UUID callIds
- `src/approvalHttp.ts` — `routeApprovalRequest` handles `POST /approvals`, `POST /approve/:id`, `POST /reject/:id`
- `dashboard/src/app/approvals/` — full desktop approval UI with risk signals, params, countdowns
- `src/server.ts` — bridge webhook dispatcher already calls `dispatchApprovalWebhook` (HTTPS only, SSRF-guarded)
- `docs/business/pro-tier.md` — target: FCM/APNS push + hosted dashboard at `app.patchwork.dev`

**What is missing for mobile oversight:**

1. A push-notification delivery path (FCM / APNS) separate from the existing generic webhook
2. A mobile-optimized approval UI (either PWA or React Native)
3. A relay/notification service so the bridge (private IP) can reach the phone (no direct route)
4. Auth: the phone must prove identity before the bridge accepts its approve/reject decisions

---

## Agent 1 — Push Notification Service

**Owner:** Backend / infra

### What to build

A lightweight cloud relay service (`notify.patchwork.dev`) that:

1. Receives a `POST /push` from the bridge (HTTPS + bearer token).
2. Looks up the FCM/APNS device token registered to the bridge's `userId`.
3. Dispatches the push notification.
4. Returns immediately — never blocks the bridge's approval flow.

### Bridge-side changes (minimal)

- **`src/config.ts`** — add `--push-service-url <url>` and `--push-service-token <token>` flags (or read from env vars `PATCHWORK_PUSH_URL` / `PATCHWORK_PUSH_TOKEN`).
- **`src/approvalHttp.ts`** — in `handleApprovalRequest`, after queuing, call a new `dispatchPushNotification(pushDeps, payload)` function (mirrors the existing `dispatchApprovalWebhook` pattern: fire-and-forget, never throws, 5s timeout, SSRF-guarded).
  - Payload: `{ userId, callId, toolName, tier, summary?, riskSignals?, requestedAt, expiresAt, bridgeCallbackUrl }`.
  - `bridgeCallbackUrl` = the bridge's public URL + `/approve/:callId` or `/reject/:callId`.
- **`src/approvalHttp.ts`** — no changes to existing webhook logic; push is a parallel path.

### Relay service (new repo or `services/push-relay/`)

- Node.js + Express, ~200 LOC.
- Endpoints: `POST /push`, `POST /devices/register`, `DELETE /devices/:deviceToken`.
- Stores `{ userId → [deviceToken] }` in Postgres (or Redis for MVP).
- Sends via `firebase-admin` (FCM) for Android + `@parse/node-apn` for iOS.
- Auth: bridge sends `Authorization: Bearer <push-service-token>`; token is per-user, issued at Pro signup.

### Testing

- Unit tests for `dispatchPushNotification` (mock fetch; verify SSRF guard, timeout, no-throw).
- Integration test: queue approval → assert push payload reaches mock relay endpoint.

---

## Agent 2 — Mobile-Optimized Approval UI (PWA)

**Owner:** Frontend

### Approach

Extend the existing Next.js dashboard (`dashboard/`) as a **Progressive Web App** before
considering a native app. This maximizes code reuse (approval data types, `useBridgeFetch`,
risk-signal components) and ships fastest.

### Changes to `dashboard/`

1. **`dashboard/src/app/manifest.json`** — add Web App Manifest (`name`, `short_name`, icons,
   `display: standalone`, `theme_color`, `background_color`). Enables "Add to Home Screen".
2. **`dashboard/next.config.*`** — add `next-pwa` (Workbox) for offline shell caching and
   push subscription registration.
3. **Service worker registration** (`dashboard/src/app/sw-register.ts`) — requests
   `Notification` permission, subscribes to Web Push (VAPID keys from relay service),
   POSTs subscription to `POST /api/push/subscribe` (new Next.js route).
4. **`dashboard/src/app/approvals/page.tsx`** — no changes needed for logic; existing UI
   already works on small screens via CSS; add `viewport` meta and responsive tweaks.
5. **`dashboard/src/app/api/push/`** (new Next.js API routes):
   - `POST /api/push/subscribe` — forwards Web Push subscription to relay service.
   - `POST /api/push/unsubscribe` — deregisters.
6. **Notification click handler in service worker** — clicking the push notification opens
   `/approvals?highlight=<callId>` and auto-focuses the pending card.

### Mobile UX requirements

- Large tap targets on Approve / Reject (min 48px).
- Countdown timer stays accurate (existing 1s `setInterval` already handles this).
- Risk-signal badges visible without expanding params.
- `callId` detail link navigates to existing `/approvals/[callId]` page — no new page needed.

### Testing

- Lighthouse PWA audit (must hit 100 on installability, push checklist).
- Manual smoke: install to iOS Safari home screen, receive push, tap → approve.

---

## Agent 3 — Bridge Authentication for Remote Phone Approvals

**Owner:** Security / backend

### Problem

When the phone's browser calls `POST /approve/:callId` through the relay or directly, the bridge
must verify the request is from an authorized user — not an attacker who guessed a callId.

### Current state

`POST /approve/:callId` in `src/server.ts` requires the `x-claude-code-ide-authorization`
bearer token (the bridge token). The phone doesn't have this token by default.

### Proposed solution: time-limited approval tokens

Add a per-callId approval token issued at queue time and delivered in the push notification.

1. **`src/approvalQueue.ts`** — `PendingApproval` gains an optional `approvalToken: string`
   (32-byte random hex, generated with `crypto.randomBytes(32).toString('hex')`).
   - Only generated when a push notification is configured (keep it opt-in — zero overhead for
     local-only users).
2. **`src/approvalHttp.ts`** — `POST /approve/:callId` and `POST /reject/:callId` accept either:
   - The existing bridge bearer token (unchanged local-dashboard path), OR
   - A `x-approval-token: <token>` header (phone path). Verified with `crypto.timingSafeEqual`.
   - Tokens are single-use: deleted from the queue entry after first use.
3. **Push payload** — `approvalToken` added to the relay push payload; relay embeds it in the
   notification action URL (`bridgeCallbackUrl?token=<approvalToken>`).
4. **`src/config.ts`** — approval tokens only generated when `pushServiceUrl` is configured.

### Security properties

- Short-lived: expires with the queue TTL (5 min default).
- Single-use: prevents replay after approval/rejection.
- Not guessable: 256-bit random, timing-safe comparison.
- Separate from bridge token: phone never receives the master bridge token.

### Testing

- Unit: `approvalQueue` generates tokens when requested; rejects expired/used tokens.
- Unit: `approvalHttp` accepts `x-approval-token` path; rejects wrong token with 401; rejects
  reuse.
- Security: confirm `crypto.timingSafeEqual` used (not `===`).

---

## Agent 4 — Integration, E2E, and Rollout

**Owner:** QA / release

### E2E test (new file: `src/__tests__/mobileOversight.e2e.test.ts`)

Scenario:
1. Start bridge with `pushServiceUrl` pointing to a local mock server.
2. Queue an approval via `POST /approvals`.
3. Assert mock server received push payload with correct `callId`, `toolName`, `approvalToken`.
4. POST `approve` with the `approvalToken` header.
5. Assert queue resolves `"approved"` and mock server got zero second push (no double-notify).

### Rollout flags

- `--push-service-url` / `--push-service-token` — feature is entirely opt-in; no behavior
  change when absent.
- `approvalGate` already controls which calls queue; mobile adds notification, not new
  gating logic.

### Dashboard settings page

Add a "Mobile notifications" card to `/settings` (or a new `/settings/notifications` page):
- Input: push service URL (for self-hosters).
- Toggle: enable/disable per-call push.
- "Test notification" button — sends a synthetic push with no callId.
- Displays registered device count from relay service.

### Documentation

- Update `docs/adr/0006-approval-gate-design.md` — note push path in the decision flow diagram.
- New `docs/mobile-oversight.md` — setup guide (install PWA, authorize bridge, test).
- Update `README.md` feature list to include mobile approvals.

---

## Dependency order

```
Agent 3 (auth tokens)  ──►  Agent 1 (push service needs token in payload)
                                │
Agent 2 (PWA)          ──►    combined in
                                │
Agent 4 (E2E)          ◄───────┘
```

Agents 2 and 3 can develop in parallel. Agent 1 needs Agent 3's token shape finalized.
Agent 4 starts once all three pass unit tests.

---

## Out of scope for MVP

- Native iOS / Android apps (PWA is sufficient for approve/reject; revisit at Pro tier launch)
- Notification batching / digest (single-call granularity is correct for oversight)
- Shared team approval delegation (Team tier feature per `pro-tier.md`)
- Offline approve/reject (requires synced state; punt to Pro hosted dashboard)

---

## Success criteria

- User queues a tool call → phone vibrates within 3 seconds.
- Tapping notification opens approval card in PWA.
- Approve/reject from phone unblocks the hook within 500ms.
- No regression in existing desktop approval flow (all 3437 tests still green).
- Lighthouse PWA score ≥ 90 on mobile.
