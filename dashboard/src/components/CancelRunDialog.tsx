"use client";

import { Dialog } from "@/components/Dialog";

/**
 * Shared confirm-dialog for stopping a running run, used by:
 *   - LiveRunsStrip (Overview page live-run cards)
 *   - GlobalLiveRunsStrip (Shell-global strip)
 *   - /runs list rows
 *   - /runs/[seq] detail header
 *
 * `POST /runs/:seq/cancel` aborts the run's registered AbortController —
 * a mid-flight interrupt of in-progress (possibly write-tier) work — so a
 * single accidental click had no confirmation anywhere in the dashboard.
 * Mirrors `KillSwitchConfirmDialog`'s shape: Cancel is first in DOM order
 * and not autofocused so Tab/Enter defaults land on the safe action.
 */
export interface CancelRunDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Recipe name / run label shown in the confirm copy. */
  recipeName?: string;
  seq?: number | null;
}

export function CancelRunDialog({
  open,
  onClose,
  onConfirm,
  recipeName,
  seq,
}: CancelRunDialogProps) {
  const label = recipeName
    ? `${recipeName}${seq != null ? ` (#${seq})` : ""}`
    : seq != null
      ? `run #${seq}`
      : "this run";

  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Stop this run?">
      <h2
        style={{
          margin: 0,
          marginBottom: "var(--s-3)",
          fontSize: "var(--fs-l)",
          color: "var(--ink-0)",
        }}
      >
        Stop this run?
      </h2>
      <p
        style={{
          margin: 0,
          marginBottom: "var(--s-5)",
          fontSize: "var(--fs-s)",
          color: "var(--ink-2)",
          lineHeight: 1.5,
        }}
      >
        This interrupts <strong>{label}</strong> mid-flight — any step in
        progress is aborted immediately. Steps already completed are not
        undone.
      </p>
      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          justifyContent: "flex-end",
        }}
      >
        <button type="button" className="btn sm ghost" onClick={onClose}>
          Keep running
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          Stop run
        </button>
      </div>
    </Dialog>
  );
}
