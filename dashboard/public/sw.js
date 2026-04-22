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

  const { callId, toolName, tier, summary, approveUrl, rejectUrl, expiresAt } = data;
  const urgency = tier === "high" ? "⚠️ " : "";
  const title = `${urgency}Approval required`;
  const body = summary ?? `Tool: ${toolName}`;
  const tag = `approval-${callId}`;
  const ttl = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 300;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      requireInteraction: true,
      data: { callId, approveUrl, rejectUrl },
      actions: [
        { action: "approve", title: "Approve" },
        { action: "reject", title: "Reject" },
      ],
      // Hint to browser — high-tier calls should wake screen
      silent: tier !== "high",
    }),
  );
  void ttl; // used for future expiry hint
});

// ── Notification click ────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { callId, approveUrl, rejectUrl } = event.notification.data ?? {};

  // Inline approve/reject actions — no need to open browser
  if (event.action === "approve" && approveUrl) {
    event.waitUntil(fetch(approveUrl, { method: "POST" }).catch(() => {}));
    return;
  }
  if (event.action === "reject" && rejectUrl) {
    event.waitUntil(fetch(rejectUrl, { method: "POST" }).catch(() => {}));
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
