/**
 * Patchwork service worker
 *
 * Responsibilities:
 *   1. Cache app shell for offline load
 *   2. Handle Web Push notifications from the relay service
 *   3. Open/focus the approval card on notification click
 */

const CACHE_NAME = "patchwork-shell-v1";
// Scope-relative so basePath (`/dashboard`) is honored. Absolute paths
// like `/approvals` route to the bridge's HTTP API and 401, which makes
// `cache.addAll` reject and the SW never activates — `serviceWorker.ready`
// then hangs forever, which manifests as a permanently stuck "Working…"
// on the Subscribe-to-push button. The SW scope is `/dashboard/`, so
// `./` resolves to `/dashboard/` and `./approvals` to `/dashboard/approvals`.
const SHELL_URLS = ["./", "./approvals"];

// ── Install: cache shell ──────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // Belt-and-braces: even if individual shell URLs 4xx, don't block
        // SW activation. Push handlers don't depend on the precache.
        cache.addAll(SHELL_URLS).catch((err) => {
          console.warn("[sw] shell precache failed (non-fatal):", err);
        }),
      )
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── pushsubscriptionchange: re-subscribe transparently ────────────────────
//
// Fires when the browser invalidates the existing push subscription —
// commonly on SW update (iOS), Apple-side token rotation, or after long
// inactivity. Without a handler the subscription is silently lost and
// the user has to manually re-Subscribe in the dashboard, which they
// won't do until the next time they notice missing notifications.
//
// Re-subscribe with the same VAPID public key fetched from the
// dashboard's /api/push/vapid-key endpoint (scope-relative), then POST
// the new subscription to /api/push/subscribe.

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keyRes = await fetch("./api/push/vapid-key");
        if (!keyRes.ok) {
          console.warn("[sw] vapid-key fetch failed:", keyRes.status);
          return;
        }
        const { publicKey } = await keyRes.json();
        if (!publicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await fetch("./api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch (err) {
        console.warn("[sw] pushsubscriptionchange re-subscribe failed:", err);
      }
    })(),
  );
});

// ── Fetch: network-first, fallback to cache ───────────────────────────────

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Only intercept same-origin navigation requests
  if (url.origin !== self.location.origin) return;
  if (!event.request.headers.get("accept")?.includes("text/html")) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r ?? Response.error())),
  );
});

// ── Push: show notification ───────────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }

  // Cancel pushes tell us to dismiss a previously-shown approval card —
  // fired when the operator downgrades the approval gate to "off" or the
  // bridge shuts down while a request is still pending, so the phone
  // isn't left with a stale "tap to approve" button whose token the
  // bridge has already invalidated server-side. Close by tag; no-op if
  // the notification was already dismissed or never arrived on this
  // device.
  if (data.kind === "cancel") {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: `approval-${data.callId}` })
        .then((notifications) => {
          for (const n of notifications) n.close();
        }),
    );
    return;
  }

  // Branch on payload kind. Approval pushes (no kind, legacy shape)
  // and halt pushes (kind === "halt") render different notifications
  // and have different click targets.
  if (data.kind === "halt") {
    const {
      recipeName,
      runSeq,
      status,
      haltReason,
      haltCategory,
      actionHint,
      stepId,
      errorMessage,
    } = data;
    const isError = status === "error";
    const title = `${isError ? "⚠️ Run errored" : "Run halted"}: ${recipeName ?? "recipe"}`;
    // Show "what + how to fix": the reason followed by the actionable hint
    // (e.g. "401 unauthorized — reconnect from /connections"), so a halt seen
    // on a phone is recoverable without opening a laptop.
    const reason =
      haltReason || errorMessage || (isError ? "Run errored" : "Run halted");
    const body = actionHint ? `${reason} — ${actionHint}` : reason;
    // Coalesce repeat fires for the same run so flapping doesn't spam.
    const tag = `halt-${runSeq ?? recipeName ?? "unknown"}`;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        requireInteraction: false,
        data: { kind: "halt", runSeq, stepId, haltCategory },
      }),
    );
    return;
  }

  // Default path: approval push.
  const {
    callId,
    toolName,
    tier,
    summary,
    approveUrl,
    rejectUrl,
    approvalToken,
    expiresAt,
  } = data;
  const urgency = tier === "high" ? "⚠️ " : "";
  const title = `${urgency}Approval required`;
  const body = summary ?? `Tool: ${toolName}`;
  const tag = `approval-${callId}`;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      requireInteraction: true,
      // expiresAt is consulted on click — see notificationclick handler.
      data: { callId, approveUrl, rejectUrl, approvalToken, expiresAt },
      actions: [
        { action: "approve", title: "Approve" },
        { action: "reject", title: "Reject" },
      ],
      // Hint to browser — high-tier calls should wake screen
      silent: tier !== "high",
    }),
  );
});

// ── Notification click ────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notifData = event.notification.data ?? {};

  // Halt notifications deep-link to the failing run/step. No inline
  // actions — the user inspects the run in the dashboard.
  if (notifData.kind === "halt") {
    const { runSeq, stepId, haltCategory } = notifData;
    // Connection-class halts (auth failure / missing connector) are fixed on
    // the /connections page, not the run page — deep-link there so the user
    // can reconnect straight from the notification tap. Everything else opens
    // the failing run/step.
    const fixOnConnections =
      haltCategory === "auth_failure" || haltCategory === "missing_connector";
    let targetUrl;
    if (fixOnConnections) {
      targetUrl = "./connections";
    } else if (runSeq) {
      targetUrl = stepId
        ? `./runs/${runSeq}#step-${encodeURIComponent(stepId)}`
        : `./runs/${runSeq}`;
    } else {
      return;
    }
    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          const existing = clients.find((c) => c.url.includes("/runs/"));
          if (existing) {
            return existing.focus().then((c) => c.navigate(targetUrl));
          }
          return self.clients.openWindow(targetUrl);
        }),
    );
    return;
  }

  const { callId, approveUrl, rejectUrl, approvalToken, expiresAt } = notifData;

  // Stale notification: token-clearing path on the bridge runs single-use,
  // so a click after expiry would 401 anyway, but we short-circuit to avoid
  // surfacing failure noise to the user / log.
  if (typeof expiresAt === "number" && Date.now() >= expiresAt) {
    return;
  }

  // The bridge reads the approval token from the `x-approval-token` header,
  // NOT from a query-string. The token in `approveUrl`/`rejectUrl` is
  // ignored server-side and would leak to access logs / Referer if used in
  // the URL. Send it as a header instead, with `credentials: "omit"` so a
  // future cookie-auth dashboard can't accidentally CSRF it.
  const fetchOpts = {
    method: "POST",
    credentials: "omit",
    headers: approvalToken ? { "x-approval-token": approvalToken } : {},
  };

  // Inline approve/reject actions — no need to open browser
  if (event.action === "approve" && approveUrl) {
    event.waitUntil(fetch(approveUrl, fetchOpts).catch(() => {}));
    return;
  }
  if (event.action === "reject" && rejectUrl) {
    event.waitUntil(fetch(rejectUrl, fetchOpts).catch(() => {}));
    return;
  }

  // Default: open/focus approval card. Scope-relative so basePath
   // (`/dashboard`) is honored — absolute `/approvals` routes through
   // nginx to the bridge HTTP API and 401s without a bearer token.
  const targetUrl = callId
    ? `./approvals?highlight=${callId}`
    : "./approvals";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url.includes("/approvals"));
        if (existing) {
          return existing.focus().then((c) => c.navigate(targetUrl));
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
