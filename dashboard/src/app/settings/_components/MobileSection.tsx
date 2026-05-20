"use client";
import { useEffect, useRef, useState } from "react";
import { StatusPill } from "@/components/patchwork";
import { apiPath } from "@/lib/api";
import {
  getPushSubscriptionEndpoint,
  getPushSubscriptionStatus,
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/pushSubscription";
import { helpStyle, labelStyle } from "./styles";

/**
 * Mobile / Web Push settings section (`#s-mobile`).
 *
 * Extracted from settings/page.tsx — self-contained. Talks to the
 * dashboard /api/push/* routes + the service worker; no shared
 * `settings` slice. The only parent dependency is `flashSaved`.
 */

type PushStatus =
  | "loading"
  | "subscribed"
  | "unsubscribed"
  | "denied"
  | "unsupported";

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export function MobileSection({ flashSaved }: { flashSaved: () => void }) {
  const [pushStatus, setPushStatus] = useState<PushStatus>("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // Per-subscription "notify me when runs halt" preference. Defaults
  // on; loaded from /api/push/prefs once a subscription exists.
  const [haltsPref, setHaltsPref] = useState(true);
  const [haltsPrefBusy, setHaltsPrefBusy] = useState(false);
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

  // Own AbortController — cancels the in-flight test POST on unmount.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current = new AbortController();
    return () => abortRef.current?.abort();
  }, []);

  // Read current Web Push subscription status on mount. Idempotently
  // register the SW so a fresh visit can later subscribe without a
  // reload — pushManager.subscribe() requires an active registration.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        await registerServiceWorker();
        const s = await getPushSubscriptionStatus();
        if (!cancel) setPushStatus(s);
      } catch {
        if (!cancel) setPushStatus("unsupported");
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  // Load the per-subscription halt-notification preference once a
  // subscription exists. Defaults on so a missing record reads enabled.
  useEffect(() => {
    if (pushStatus !== "subscribed") return;
    let cancel = false;
    (async () => {
      try {
        const endpoint = await getPushSubscriptionEndpoint();
        if (!endpoint || cancel) return;
        const res = await fetch(
          apiPath(`/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`),
        );
        if (!res.ok || cancel) return;
        const data = (await res.json()) as { prefs?: { halts?: boolean } };
        if (!cancel && typeof data.prefs?.halts === "boolean") {
          setHaltsPref(data.prefs.halts);
        }
      } catch {
        // fail-soft — leave the default
      }
    })();
    return () => {
      cancel = true;
    };
  }, [pushStatus]);

  async function handlePushSubscribe() {
    if (!vapidPublicKey) {
      setPushMsg({
        ok: false,
        text: "NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set. Generate keys with `npx web-push generate-vapid-keys`, add them to dashboard/.env.local, and rebuild.",
      });
      return;
    }
    setPushBusy(true);
    setPushMsg(null);
    try {
      await registerServiceWorker();
      await subscribeToPush(vapidPublicKey);
      setPushStatus("subscribed");
      setPushMsg({
        ok: true,
        text: "Subscribed. Use 'Send test notification' to confirm delivery.",
      });
      flashSaved();
    } catch (e) {
      if (isAbortError(e)) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Re-read browser status so the badge reflects what actually
      // happened (permission denied vs subscribe stalled).
      try {
        const s = await getPushSubscriptionStatus();
        setPushStatus(s);
      } catch {
        /* status read itself failed — leave previous value */
      }
      setPushMsg({ ok: false, text: msg });
    } finally {
      setPushBusy(false);
    }
  }

  async function handlePushUnsubscribe() {
    setPushBusy(true);
    setPushMsg(null);
    try {
      await unsubscribeFromPush();
      setPushStatus("unsubscribed");
      setPushMsg({ ok: true, text: "Unsubscribed." });
      flashSaved();
    } catch (e) {
      if (isAbortError(e)) return;
      setPushMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPushBusy(false);
    }
  }

  async function handleHaltsPrefToggle(next: boolean) {
    setHaltsPrefBusy(true);
    // Optimistic — revert on failure.
    const prev = haltsPref;
    setHaltsPref(next);
    try {
      const endpoint = await getPushSubscriptionEndpoint();
      if (!endpoint) throw new Error("no active push subscription");
      const res = await fetch(apiPath("/api/push/prefs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, halts: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      flashSaved();
    } catch (e) {
      setHaltsPref(prev);
      setPushMsg({
        ok: false,
        text: `Couldn't update halt-notification preference: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setHaltsPrefBusy(false);
    }
  }

  async function handlePushTest() {
    setPushBusy(true);
    setPushMsg(null);
    try {
      const res = await fetch(apiPath("/api/push/test"), {
        method: "POST",
        signal: abortRef.current?.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sent?: number;
        total?: number;
        invalid?: number;
        error?: string;
      };
      if (res.ok) {
        const sent = body.sent ?? 0;
        const total = body.total ?? 0;
        const invalid = body.invalid ?? 0;
        // All subs returned 404/410 → most likely VAPID key rotated
        // since the existing subs were created. Surface explicitly.
        if (invalid > 0 && invalid === total && sent === 0) {
          setPushMsg({
            ok: false,
            text: `Sent 0 of ${total} — every subscription returned 410/404. Likely VAPID key changed since subscribing; have devices re-subscribe.`,
          });
        } else if (invalid > 0) {
          setPushMsg({
            ok: true,
            text: `Sent ${sent} of ${total} subscribers (${invalid} stale, pruning recommended).`,
          });
        } else {
          setPushMsg({
            ok: true,
            text: `Sent ${sent} of ${total} subscribers.`,
          });
        }
      } else {
        setPushMsg({
          ok: false,
          text: body.error ?? `Error ${res.status}`,
        });
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setPushMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div id="s-mobile" className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2 style={{ margin: 0 }}>Mobile</h2>
          <div
            style={{
              fontSize: "var(--fs-s)",
              color: "var(--ink-2)",
              marginTop: 2,
            }}
          >
            Get push notifications on your phone when an approval is pending.
            Install this dashboard as a PWA, then subscribe here.
          </div>
        </div>
      </div>

      <div
        style={{
          padding: "16px 0",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <span style={labelStyle}>Status</span>
          {pushStatus === "loading" && (
            <StatusPill tone="muted">Checking…</StatusPill>
          )}
          {pushStatus === "subscribed" && (
            <StatusPill tone="ok" dot>
              Subscribed
            </StatusPill>
          )}
          {pushStatus === "unsubscribed" && (
            <StatusPill tone="muted">Not subscribed</StatusPill>
          )}
          {pushStatus === "denied" && (
            <StatusPill tone="err">Permission denied</StatusPill>
          )}
          {pushStatus === "unsupported" && (
            <StatusPill tone="warn">Not supported</StatusPill>
          )}
        </div>
        {pushStatus === "unsupported" && (
          <p style={helpStyle}>
            This browser does not support Web Push. Install Chrome on Android,
            or Safari 16.4+ on iOS — and on iOS the dashboard must be opened
            from a home-screen icon, not a Safari tab.
          </p>
        )}
        {pushStatus === "denied" && (
          <p style={helpStyle}>
            Notification permission was denied. Re-enable it in the browser&apos;s
            site settings for this origin, then reload this page.
          </p>
        )}
        {!vapidPublicKey && pushStatus !== "subscribed" && (
          <p style={{ ...helpStyle, color: "var(--err)" }}>
            <code>NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> is not set. Generate a
            keypair with <code>npx web-push generate-vapid-keys</code>, add the
            values to <code>dashboard/.env.local</code>, and rebuild before
            subscribing.
          </p>
        )}
        {!vapidPublicKey && pushStatus === "subscribed" && (
          <p style={{ ...helpStyle, color: "var(--warn)" }}>
            This subscription was made when VAPID keys were configured. The
            server can no longer send notifications until keys are restored —
            or you can unsubscribe to clear the stale subscription.
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {pushStatus !== "subscribed" && (
            <button
              type="button"
              disabled={
                pushBusy ||
                !vapidPublicKey ||
                pushStatus === "unsupported" ||
                pushStatus === "denied" ||
                pushStatus === "loading"
              }
              onClick={handlePushSubscribe}
              style={{
                fontSize: "var(--fs-s)",
                fontWeight: 600,
                padding: "6px 12px",
                borderRadius: "var(--r-2)",
                border: "none",
                background: "var(--accent)",
                color: "var(--on-orange)",
                cursor:
                  pushBusy ||
                  !vapidPublicKey ||
                  pushStatus === "unsupported" ||
                  pushStatus === "denied" ||
                  pushStatus === "loading"
                    ? "default"
                    : "pointer",
                opacity:
                  pushBusy ||
                  !vapidPublicKey ||
                  pushStatus === "unsupported" ||
                  pushStatus === "denied" ||
                  pushStatus === "loading"
                    ? 0.5
                    : 1,
              }}
            >
              {pushBusy ? "Working…" : "Subscribe to push"}
            </button>
          )}
          {pushStatus === "subscribed" && (
            <>
              <button
                type="button"
                disabled={pushBusy || !vapidPublicKey}
                onClick={handlePushTest}
                title={
                  !vapidPublicKey
                    ? "VAPID keys not configured — server cannot send notifications"
                    : undefined
                }
                style={{
                  fontSize: "var(--fs-s)",
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: "var(--r-2)",
                  border: "none",
                  background: "var(--accent)",
                  color: "var(--on-orange)",
                  cursor: pushBusy || !vapidPublicKey ? "default" : "pointer",
                  opacity: pushBusy || !vapidPublicKey ? 0.5 : 1,
                }}
              >
                {pushBusy ? "Working…" : "Send test notification"}
              </button>
              <button
                type="button"
                disabled={pushBusy}
                onClick={handlePushUnsubscribe}
                style={{
                  fontSize: "var(--fs-s)",
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--line-2)",
                  background: "transparent",
                  color: "var(--ink-1)",
                  cursor: pushBusy ? "default" : "pointer",
                  opacity: pushBusy ? 0.5 : 1,
                }}
              >
                Unsubscribe
              </button>
            </>
          )}
        </div>
        {pushStatus === "subscribed" && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
              fontSize: "var(--fs-s)",
              color: "var(--ink-1)",
              cursor: haltsPrefBusy ? "default" : "pointer",
              opacity: haltsPrefBusy ? 0.6 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={haltsPref}
              disabled={haltsPrefBusy}
              onChange={(e) => handleHaltsPrefToggle(e.target.checked)}
            />
            Notify me when a recipe run halts or errors
          </label>
        )}
        {pushMsg && (
          <p
            style={{
              fontSize: "var(--fs-s)",
              color: pushMsg.ok ? "var(--ok)" : "var(--err)",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            {pushMsg.text}
          </p>
        )}
      </div>

      <div style={{ padding: "16px 0" }}>
        <div style={labelStyle}>Install as PWA</div>
        <p style={helpStyle}>
          <strong>iOS Safari (16.4+):</strong> open this dashboard in Safari,
          tap the Share icon, then &quot;Add to Home Screen&quot;. Push only
          works when launched from the home-screen icon.
          <br />
          <strong>Android Chrome:</strong> 3-dot menu → &quot;Install app&quot;
          (or &quot;Add to Home screen&quot;).
        </p>
        <p style={{ ...helpStyle, marginTop: 8 }}>
          Native FCM/APNS delivery via the patchwork push relay is configured
          separately on the bridge (env vars <code>PATCHWORK_PUSH_URL</code>,{" "}
          <code>PATCHWORK_PUSH_TOKEN</code>, <code>PATCHWORK_PUSH_BASE_URL</code>)
          and is not required for browser/PWA notifications.
        </p>
      </div>
    </div>
  );
}
