"use client";
import { useEffect, useRef } from "react";
import { useActiveRuns } from "@/hooks/LiveRunsContext";
import { useToast } from "@/components/Toast";
import type { ActiveRunState } from "@/hooks/useRecipeRunStream";

/**
 * Mount-once watcher: subscribes to the LiveRuns store and fires an
 * in-app toast whenever a recipe transitions from "running" to a
 * terminal failure state (halted or error). The toast carries a
 * deep-link to the failing step on /runs/:seq when stepId is known.
 *
 * Web Push (background) is a separate follow-up — VAPID + service
 * worker need wiring. This component covers the foreground case.
 */
export function HaltToastWatcher() {
  const runs = useActiveRuns();
  const toast = useToast();
  const prevRef = useRef<Map<string, ActiveRunState>>(new Map());
  const initialMountRef = useRef(true);

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
    }

    prevRef.current = runs;
  }, [runs, toast]);

  return null;
}
