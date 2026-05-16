"use client";

import { Dialog } from "@/components/Dialog";
import type { RiskLevel } from "@/lib/registry";

/**
 * Shared install-confirmation dialog used by:
 *   - browse view RecipeCard (single recipe, gated by `elevated`)
 *   - detail-page InstallPanel (single recipe, gated by `elevated`)
 *   - bundle detail panel (always shown — bundles are inherently elevated
 *     because they install multiple recipes + may pull plugins / policies)
 *
 * Renders nothing when `open=false`; consumers control open/close via state.
 */
export interface InstallConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Heading + dialog ariaLabel suffix — e.g. "morning-brief" or "morning bundle". */
  name: string;
  /** Verbatim install source (`github:owner/repo[/path]`), shown inline. */
  source: string;
  /** Optional risk level — drives the colour-coded pill. */
  riskLevel?: RiskLevel;
  /** Optional connector list shown as a comma-separated row. */
  connectors?: string[];
  /** Adds a "Network access" bullet when truthy. */
  networkAccess?: boolean;
  /** Adds a "File access" bullet when truthy. */
  fileAccess?: boolean;
  /** Optional extra bullets (e.g. bundle plugin / policy advisory). */
  extraBullets?: string[];
  /** Confirm button label, default "Install". Bundles use "Install bundle". */
  confirmLabel?: string;
}

const RISK_COLOUR: Record<RiskLevel, string> = {
  low: "var(--ok)",
  medium: "var(--warn)",
  high: "var(--err)",
};

export function InstallConfirmDialog({
  open,
  onClose,
  onConfirm,
  name,
  source,
  riskLevel,
  connectors,
  networkAccess,
  fileAccess,
  extraBullets,
  confirmLabel = "Install",
}: InstallConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={`Confirm install of ${name}`}
    >
      <h2
        style={{
          margin: 0,
          marginBottom: "var(--s-3)",
          fontSize: "var(--fs-l)",
          color: "var(--ink-0)",
        }}
      >
        Install {name}?
      </h2>
      <p
        style={{
          margin: 0,
          marginBottom: "var(--s-4)",
          fontSize: "var(--fs-s)",
          color: "var(--fg-2)",
          lineHeight: 1.5,
        }}
      >
        The recipe YAML will be fetched from{" "}
        <code
          style={{
            background: "var(--recess)",
            padding: "1px 5px",
            borderRadius: 4,
            fontSize: "var(--fs-xs)",
            wordBreak: "break-all",
          }}
        >
          {source}
        </code>{" "}
        and stored locally.
      </p>
      <ul
        style={{
          margin: 0,
          marginBottom: "var(--s-5)",
          paddingLeft: "var(--s-4)",
          fontSize: "var(--fs-s)",
          color: "var(--ink-1)",
          lineHeight: 1.7,
        }}
      >
        {riskLevel && (
          <li>
            <strong>Risk:</strong>{" "}
            <span style={{ color: RISK_COLOUR[riskLevel] }}>{riskLevel}</span>
          </li>
        )}
        {connectors && connectors.length > 0 && (
          <li>
            <strong>Connectors:</strong> {connectors.join(", ")}
          </li>
        )}
        {networkAccess && <li>Network access</li>}
        {fileAccess && <li>File access</li>}
        {extraBullets?.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <div
        style={{
          display: "flex",
          gap: "var(--s-2)",
          justifyContent: "flex-end",
        }}
      >
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
          // biome-ignore lint/a11y/noAutofocus: dialog-scoped — focus moves
          // into the panel anyway and Enter should confirm the primary action.
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
