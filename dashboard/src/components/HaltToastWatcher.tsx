"use client";
import { useEffect, useMemo, useRef } from "react";
import { useActiveRuns } from "@/hooks/LiveRunsContext";
import { useToast } from "@/components/Toast";
import {
  getPushSubscriptionStatus,
  registerServiceWorker,
  subscribeToPush,
} from "@/lib/pushSubscription";
import type { ActiveRunState } from "@/hooks/useRecipeRunStream";

/**
 * Mount-once watcher: subscribes to the LiveRuns store and fires an
 * in-app toast whenever a recipe transitions from "running" to a
 * terminal failure state (halted or error). The toast carries a
 * deep-link to the failing step on /runs/:seq when stepId is known.
 *
 * The first time a halt fires while the user is NOT subscribed to
 * Web Push, it also offers a one-time "Enable push" toast so they
 * can opt in to background notifications — clicking it runs the
 * subscribe flow (the click is the user gesture the Notification
 * permission prompt requires). Dismissal is remembered so the offer
 * never repeats.
 */

const PROMPTED_KEY = "patchwork:halt-push-prompted";

function alreadyPrompted(): boolean {
  try {
    return localStorage.getItem(PROMPTED_KEY) === "1";
  } catch {
    return true; // localStorage unavailable — treat as prompted, never nag
  }
}

function markPrompted(): void {
  try {
    localStorage.setItem(PROMPTED_KEY, "1");
  } catch {
    // ignore
  }
}

export function HaltToastWatcher() {
  const runs = useActiveRuns();
  const toast = useToast();
  const prevRef = useRef<Map<string, ActiveRunState>>(new Map());
  const initialMountRef = useRef(true);
  // Guards the one-time push-opt-in offer within this tab's lifetime,
  // independent of the localStorage flag (which also survives reloads).
  const offeredPushRef = useRef(false);

  // Derive a stable string key from only the halt-relevant fields so the
  // effect does not re-fire on every SSE event that creates a new Map
  // reference without changing halt status or haltReason.
  const runsKey = useMemo(
    () =>
      JSON.stringify(
        [...runs.entries()].map(([name, r]) => [
          name,
          r.status,
          r.haltReason ?? null,
          r.runSeq,
        ]),
      ),
    [runs],
  );

  useEffect(() => {
    // On the very first render we get whatever state the store
    // already holds — skip toasts so we don't bark about runs that
    // were already terminal before the user opened the tab.
    if (initialMountRef.current) {
      initialMountRef.current = false;
      prevRef.current = runs;
      return;
    }

    const prev = prevRef.current;
    for (const [name, cur] of runs) {
      const before = prev.get(name);
      if (!before) continue;
      const wasRunning = before.status === "running";
      const nowFailed = cur.status === "halted" || cur.status === "error";
      if (!(wasRunning && nowFailed)) continue;

      const reason =
        cur.haltReason ??
        cur.lastError ??
        (cur.status === "halted" ? "Run halted" : "Run errored");
      const stepFrag = cur.currentStepId ? `#step-${cur.currentStepId}` : "";
      const href = cur.runSeq > 0 ? `/runs/${cur.runSeq}${stepFrag}` : null;

      toast.error(`${name}: ${reason}`, {
        // Use a stable id keyed on runSeq so a series of error events
        // for the same run can't spam the toast region.
        id: `halt-${cur.runSeq || name}`,
        duration: 10_000,
        action: href
          ? {
              label: "Open run",
              onClick: () => {
                window.location.href = href;
              },
            }
          : undefined,
      });

      maybeOfferPush();
    }

    prevRef.current = runs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsKey, toast]);

  // Fire the one-time "Enable push" offer if the user isn't already
  // subscribed and hasn't been asked before. Separate toast (not an
  // extra action on the halt toast — Toast supports a single action).
  function maybeOfferPush() {
    if (offeredPushRef.current || alreadyPrompted()) return;
    offeredPushRef.current = true;
    void (async () => {
      let status: Awaited<ReturnType<typeof getPushSubscriptionStatus>>;
      try {
        status = await getPushSubscriptionStatus();
      } catch {
        return;
      }
      // Only worth offering when push is genuinely available + off.
      if (status !== "unsubscribed") return;
      markPrompted();
      toast.info("Get notified about halts even when this tab is closed.", {
        id: "halt-push-offer",
        duration: 0, // sticky — needs an explicit decision
        action: {
          label: "Enable push",
          onClick: () => {
            void enablePush();
          },
        },
      });
    })();
  }

  async function enablePush() {
    const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
    if (!vapid) {
      toast.error("Push isn't configured on this server.");
      return;
    }
    try {
      await registerServiceWorker();
      await subscribeToPush(vapid);
      toast.success("Push enabled — you'll be notified when runs halt.");
    } catch (e) {
      toast.error(
        `Couldn't enable push: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return null;
}
