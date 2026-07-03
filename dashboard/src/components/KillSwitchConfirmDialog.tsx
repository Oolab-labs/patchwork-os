"use client";

import { Dialog } from "@/components/Dialog";

/**
 * Shared confirm-dialog for the global write kill-switch, used by:
 *   - KillSwitchBanner (release-only, shown when the switch is engaged)
 *   - settings/page.tsx Safety card ToggleRow (both engage + release)
 *
 * The kill-switch fans out to every connected bridge and blocks/unblocks
 * ALL write-tier tool calls — engaging or releasing it with a single
 * accidental click had no confirmation anywhere in the dashboard. This
 * dialog is an additional gate in front of the existing
 * `POST /api/bridge/kill-switch` call; it does not change that call's
 * shape or the locked/lockedReason handling.
 *
 * Renders nothing when `open=false`; consumers control open/close via state.
 */
export interface KillSwitchConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Which direction the pending action goes — drives copy + confirm label. */
  direction: "engage" | "release";
}

const COPY: Record<
  "engage" | "release",
  { title: string; body: string; confirmLabel: string }
> = {
  engage: {
    title: "Engage the kill-switch?",
    body: "This disables ALL writes across every connected bridge — recipe runs, git pushes, file edits, everything — until released.",
    confirmLabel: "Engage kill-switch",
  },
  release: {
    title: "Release the kill-switch?",
    body: "This re-enables all writes across every connected bridge immediately.",
    confirmLabel: "Release kill-switch",
  },
};

export function KillSwitchConfirmDialog({
  open,
  onClose,
  onConfirm,
  direction,
}: KillSwitchConfirmDialogProps) {
  const { title, body, confirmLabel } = COPY[direction];

  return (
    <Dialog open={open} onClose={onClose} ariaLabel={title}>
      <h2
        style={{
          margin: 0,
          marginBottom: "var(--s-3)",
          fontSize: "var(--fs-l)",
          color: "var(--ink-0)",
        }}
      >
        {title}
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
        {body}
      </p>
      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          justifyContent: "flex-end",
        }}
      >
        {/* Cancel is the default/easily-reachable action — first in DOM
            order and NOT autofocused, so Tab/Enter defaults land here
            rather than on the destructive confirm button. */}
        <button type="button" className="btn sm ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
