/**
 * Bridge → push relay dispatch for recipe halt events.
 *
 * Sibling of `dispatchPushNotification` in [src/approvalHttp.ts](./approvalHttp.ts).
 * The bridge POSTs a halt payload to `${pushServiceUrl}/halt`; the relay
 * (a hosted push service or the dashboard's `/api/relay/halt` route)
 * fans it out to every subscribed browser via Web Push.
 *
 * Outbound safety is `pinnedSend`, shared with every approval-notification
 * sender: HTTPS-only (checked here), every resolved address checked against
 * the private ranges, the checked address pinned for the connection so DNS
 * is never re-resolved, no redirects followed. 5s abort timeout,
 * fire-and-forget so the recipe runner is never blocked on a push relay
 * outage.
 *
 * Wired via `wireHaltPushDispatch` (subscribes to ActivityLog) — keeps
 * the runner itself ignorant of push transport.
 */

import { pinnedSend } from "./pinnedSend.js";

export interface HaltPushPayload {
  recipeName: string;
  runSeq: number;
  /** Always "error" or "halted" — the runner emits "error" today; the
   *  shape leaves room for the dashboard's halted/error distinction. */
  status: "error" | "halted";
  haltReason?: string;
  haltCategory?: string;
  /** Actionable one-liner for this category (HALT_CATEGORY_HINTS) — lets the
   *  push notification / SW show "what to do" without importing the TS hint
   *  map. Source of truth: src/recipes/haltCategory.ts. */
  actionHint?: string;
  stepId?: string;
  errorMessage?: string;
  occurredAt?: number;
}

/**
 * Fire-and-forget dispatch. Never throws — caller cannot recover from a
 * push relay outage. Logged via console.warn for ops visibility.
 */
export async function dispatchHaltPushNotification(
  pushServiceUrl: string,
  pushServiceToken: string,
  payload: HaltPushPayload,
  allowPrivate: boolean = false,
): Promise<void> {
  if (!pushServiceUrl.startsWith("https://")) {
    console.warn(`[halt-push] Rejected non-HTTPS push service URL`);
    return;
  }
  let hostname: string;
  try {
    hostname = new URL(pushServiceUrl).hostname;
  } catch {
    console.warn(`[halt-push] Malformed push service URL — skipping`);
    return;
  }
  if (hostname === "localhost") {
    console.warn(`[halt-push] Blocked loopback push service hostname`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    // DNS check + connection pin + no redirects, in one place shared with
    // every approval-notification sender (security sweep L3). Returns null
    // when refused before connecting — already warned as [halt-push].
    const res = await pinnedSend(
      `${pushServiceUrl}/halt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pushServiceToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
      { label: "halt-push", allowPrivate },
    );
    if (res === null) return;
    if (!res.ok) {
      // 404 is informational ("no subscribers yet") — same relay
      // contract as the approval path. Anything else is worth a warn.
      if (res.status !== 404) {
        console.warn(
          `[halt-push] Non-2xx from push relay: ${res.status} ${res.statusText}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[halt-push] Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
