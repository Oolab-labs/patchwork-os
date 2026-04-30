/**
 * Patchwork service worker
 *
 * Responsibilities:
 *   1. Cache app shell for offline load
 *   2. Handle Web Push notifications from the relay service
 *   3. Open/focus the approval card on notification click
 */

const CACHE_NAME = "patchwork-shell-v1";
const SHELL_URLS = ["/", "/approvals"];

// ── Install: cache shell ──────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
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
  const { callId, approveUrl, rejectUrl, approvalToken, expiresAt } =
    event.notification.data ?? {};

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

  // Default: open/focus approval card
  const targetUrl = callId
    ? `/approvals?highlight=${callId}`
    : "/approvals";

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
