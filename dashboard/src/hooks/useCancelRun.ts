"use client";

import { useCallback, useState } from "react";
import { apiPath } from "@/lib/api";
import { useToast } from "@/components/Toast";

export type CancelRunPhase = "idle" | "confirming" | "cancelling";

interface CancelRunResponse {
  cancelled: boolean;
  seq: number;
}

/**
 * Shared "Stop a running run" flow — wraps `POST /api/bridge/runs/:seq/cancel`
 * (proxies the bridge's `POST /runs/:seq/cancel`, which aborts the run's
 * registered AbortController; 200 `{cancelled:true}` when a live run was
 * found, 404 `{cancelled:false}` otherwise).
 *
 * Mid-flight interrupt is destructive-ish (stops in-progress work), so the
 * call site is expected to gate the actual `cancel()` invocation behind a
 * confirm dialog — this hook exposes `phase` (idle → confirming →
 * cancelling → idle) so a single call site can drive both the confirm
 * dialog's `open` state and the button's disabled/label state from one
 * source of truth, mirroring the inline confirm state machines already
 * used for kill-switch and replay on this page.
 *
 * Keyed per-run (not global) via the `seq` passed to each call, so
 * multiple live-run rows can each carry independent phase without
 * colliding — callers track "which seq is this hook instance for"
 * themselves (one hook instance per row, or store seq alongside phase).
 *
 * On success, calls the optional `onCancelled(seq)` callback so the call
 * site can optimistically flip its local run/row state to "cancelled"
 * without waiting on the next poll / SSE tick. On failure, phase reverts
 * to "idle" (the caller's row should fall back to rendering "running")
 * and a toast reports the error.
 */
export function useCancelRun(onCancelled?: (seq: number) => void) {
  const toast = useToast();
  const [phase, setPhase] = useState<CancelRunPhase>("idle");
  const [seq, setSeq] = useState<number | null>(null);

  const requestConfirm = useCallback((targetSeq: number) => {
    setSeq(targetSeq);
    setPhase("confirming");
  }, []);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setSeq(null);
  }, []);

  const confirm = useCallback(async () => {
    if (seq == null) return;
    const targetSeq = seq;
    setPhase("cancelling");
    try {
      const res = await fetch(apiPath(`/api/bridge/runs/${targetSeq}/cancel`), {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as Partial<CancelRunResponse>;
      if (res.ok && data.cancelled) {
        setPhase("idle");
        setSeq(null);
        onCancelled?.(targetSeq);
        return;
      }
      toast.error(
        res.status === 404
          ? `Run #${targetSeq} is no longer running — nothing to stop.`
          : `Couldn't stop run #${targetSeq}: HTTP ${res.status}`,
      );
      setPhase("idle");
      setSeq(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't stop run #${targetSeq}: ${msg}`);
      setPhase("idle");
      setSeq(null);
    }
  }, [seq, onCancelled, toast]);

  return {
    /** Current lifecycle phase of the (at most one) in-flight cancel flow. */
    phase,
    /** The seq currently being confirmed/cancelled, if any. */
    cancelSeq: seq,
    /** Open the confirm dialog for the given run. */
    requestConfirm,
    /** Close the confirm dialog without cancelling. */
    dismiss,
    /** Confirm the pending cancel — fires the request. */
    confirm,
  };
}
