import { apiPath } from "./api";

/**
 * Web Push subscription helpers — called from the dashboard settings page.
 *
 * Flow:
 *   1. registerServiceWorker() — idempotent, call on app mount
 *   2. subscribeToPush(vapidPublicKey) — requests Notification permission,
 *      subscribes via SW, POSTs to /api/push/subscribe
 *   3. unsubscribeFromPush() — removes SW subscription + calls /api/push/unsubscribe
 */

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/dashboard/sw.js", { scope: "/dashboard/" });
    return reg;
  } catch (err) {
    console.error("[pwa] SW registration failed:", err);
    return null;
  }
}

/**
 * Wrap a promise with a deadline. Without this, iOS PWA push hangs at
 * `pushManager.subscribe()` are silent forever — Apple's push registration
 * sometimes never completes on first install, and the page sits in
 * "Working…" with no indication where the stall happened.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  step: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`stalled at ${step} (>${Math.round(ms / 1000)}s)`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Subscribe to web push. Throws labeled Error on any step failure so
 * callers can surface "stalled at pushManager.subscribe" etc. to the UI
 * instead of seeing a perma-stuck busy state. Returns true on success.
 *
 * Common failure points (especially iOS):
 *   - serviceWorker.ready: SW registration didn't finish (rare, usually
 *     means the SW file 404'd at install time)
 *   - pushManager.subscribe: Apple's APNs registration timed out — this
 *     is the iOS PWA "first subscribe sometimes hangs" bug. Force-close
 *     and reopen the PWA, then retry.
 *   - POST /api/push/subscribe: dashboard same-origin guard rejected the
 *     request, or VAPID is misconfigured server-side.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push API not available in this browser");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}`);
  }

  const reg = await withTimeout(
    navigator.serviceWorker.ready,
    10_000,
    "serviceWorker.ready",
  );

  const subscription = await withTimeout(
    reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }),
    15_000,
    "pushManager.subscribe (Apple/Mozilla push server)",
  );

  const res = await withTimeout(
    fetch(apiPath("/api/push/subscribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    }),
    10_000,
    "POST /api/push/subscribe",
  );
  if (!res.ok) {
    throw new Error(`POST /api/push/subscribe → HTTP ${res.status}`);
  }
  return true;
}

export async function unsubscribeFromPush(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration("/dashboard/");
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  await fetch(apiPath("/api/push/unsubscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  return sub.unsubscribe();
}

export async function getPushSubscriptionStatus(): Promise<"subscribed" | "denied" | "unsubscribed" | "unsupported"> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/dashboard/");
  if (!reg) return "unsubscribed";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "unsubscribed";
}

/**
 * Endpoint URL of the current browser's push subscription, or null if
 * not subscribed. The endpoint is the stable key the bridge / dashboard
 * push store uses, so callers need it to read or update per-subscription
 * preferences (see /api/push/prefs).
 */
export async function getPushSubscriptionEndpoint(): Promise<string | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return null;
  const reg = await navigator.serviceWorker.getRegistration("/dashboard/");
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
