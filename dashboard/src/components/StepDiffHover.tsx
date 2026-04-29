"use client";
/**
 * StepDiffHover — popover that shows a step's registry-diff plus its
 * resolvedParams + output. Used by `/runs/[seq]` page on row hover.
 *
 * Renders into a React Portal anchored to `document.body` so it escapes
 * the parent steps card's `overflow: hidden` clip. Position is
 * fixed-coordinate, computed from the trigger row's `getBoundingClientRect`
 * passed in via the `anchorRect` prop.
 *
 * Closes on Escape. Caller controls hover-leave dismissal via the wrapping
 * row's `onMouseLeave`.
 *
 * Caps each section at 50 rows + "and N more" so a step that adds 200
 * keys doesn't blow up the layout.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type StepDiffResult,
  changeCount,
} from "@/lib/registryDiff";

const MAX_ROWS_PER_SECTION = 50;
const MAX_VALUE_PREVIEW_CHARS = 200;
const PANEL_OFFSET_PX = 4;

function previewValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string")
    return value.length > MAX_VALUE_PREVIEW_CHARS
      ? `${value.slice(0, MAX_VALUE_PREVIEW_CHARS)}…`
      : value;
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_VALUE_PREVIEW_CHARS
      ? `${json.slice(0, MAX_VALUE_PREVIEW_CHARS)}…`
      : json;
  } catch {
    return String(value);
  }
}

interface Props {
  /** Discriminated diff result. `unavailable` (pre-VD-2) and `truncated`
   *  (>8 KB capture envelope) get distinct empty states. */
  result: StepDiffResult;
  resolvedParams?: unknown;
  output?: unknown;
  /** Bounding rect of the trigger row in viewport coordinates. The panel
   *  positions itself just below this rect. */
  anchorRect: DOMRect | null;
  onClose: () => void;
}

export function StepDiffHover({
  result,
  resolvedParams,
  output,
  anchorRect,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Wait for the portal target to exist before rendering — avoids SSR
  // hydration noise for the `document.body` reference.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted || !anchorRect) return null;

  // Position: fixed coordinates relative to viewport. Clamp to the right
  // edge so the panel doesn't overflow the window (the source row is
  // typically full-width, so left=row.left + small inset is fine).
  const top = anchorRect.bottom + PANEL_OFFSET_PX;
  const left = anchorRect.left + 56; // align with step-row content (past index col)
  const maxWidth = Math.max(320, anchorRect.right - left - 16);

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    top,
    left,
    maxWidth,
  };

  const body = renderBody({
    result,
    resolvedParams,
    output,
  });

  return createPortal(
    <div
      ref={ref}
      className="step-diff-hover"
      role="dialog"
      aria-label="Step detail"
      style={panelStyle}
    >
      {body}
    </div>,
    document.body,
  );
}

function renderBody({
  result,
  resolvedParams,
  output,
}: {
  result: StepDiffResult;
  resolvedParams?: unknown;
  output?: unknown;
}) {
  if (result.kind === "unavailable") {
    return (
      <div className="step-diff-section step-diff-empty">
        Step capture unavailable for this run (pre-VD-2 or non-bridge run).
      </div>
    );
  }

  // `truncated` still renders the params + output sections (those have
  // their own per-field truncation envelopes that the user may want to
  // inspect), but skips the registry-diff section since that's the noise
  // source.
  const isTruncated = result.kind === "truncated";

  return (
    <>
      {resolvedParams !== undefined && (
        <div className="step-diff-section">
          <div className="step-diff-heading">Resolved params</div>
          <div className="step-diff-value mono">{previewValue(resolvedParams)}</div>
        </div>
      )}

      {output !== undefined && (
        <div className="step-diff-section">
          <div className="step-diff-heading">Output</div>
          <div className="step-diff-value mono">{previewValue(output)}</div>
        </div>
      )}

      {isTruncated ? (
        <div className="step-diff-section">
          <div className="step-diff-heading">Registry changes</div>
          <div className="step-diff-empty">
            Registry diff unavailable — this step's snapshot exceeded 8 KB and
            was truncated. Per-field captures above are still inspectable.
          </div>
        </div>
      ) : (
        renderDiff(result.diff)
      )}
    </>
  );
}

function renderDiff(diff: import("@/lib/registryDiff").RegistryDiff) {
  const totalChanges = changeCount(diff);
  const addedKeys = Object.keys(diff.added);
  const addedShown = addedKeys.slice(0, MAX_ROWS_PER_SECTION);
  const addedHidden = addedKeys.length - addedShown.length;
  const modifiedShown = diff.modified.slice(0, MAX_ROWS_PER_SECTION);
  const modifiedHidden = diff.modified.length - modifiedShown.length;
  const removedShown = diff.removed.slice(0, MAX_ROWS_PER_SECTION);
  const removedHidden = diff.removed.length - removedShown.length;

  return (
    <div className="step-diff-section">
      <div className="step-diff-heading">
        Registry changes <span className="muted">({totalChanges})</span>
      </div>

      {totalChanges === 0 && (
        <div className="step-diff-empty">No registry changes from this step.</div>
      )}

      {addedShown.length > 0 && (
        <div className="step-diff-group">
          <div className="step-diff-group-label step-diff-added">
            + Added ({addedKeys.length})
          </div>
          {addedShown.map((k) => (
            <div key={`+${k}`} className="step-diff-row">
              <span className="step-diff-key mono">{k}</span>
              <span className="step-diff-value-inline mono">
                {previewValue(diff.added[k])}
              </span>
            </div>
          ))}
          {addedHidden > 0 && (
            <div className="step-diff-row muted">…and {addedHidden} more</div>
          )}
        </div>
      )}

      {modifiedShown.length > 0 && (
        <div className="step-diff-group">
          <div className="step-diff-group-label step-diff-modified">
            ~ Modified ({diff.modified.length})
          </div>
          {modifiedShown.map(({ key, before, after }) => (
            <div key={`~${key}`} className="step-diff-row">
              <span className="step-diff-key mono">{key}</span>
              <span className="step-diff-value-inline mono">
                {previewValue(before)} → {previewValue(after)}
              </span>
            </div>
          ))}
          {modifiedHidden > 0 && (
            <div className="step-diff-row muted">…and {modifiedHidden} more</div>
          )}
        </div>
      )}

      {removedShown.length > 0 && (
        <div className="step-diff-group">
          <div className="step-diff-group-label step-diff-removed">
            − Removed ({diff.removed.length})
          </div>
          {removedShown.map((k) => (
            <div key={`-${k}`} className="step-diff-row">
              <span className="step-diff-key mono">{k}</span>
            </div>
          ))}
          {removedHidden > 0 && (
            <div className="step-diff-row muted">…and {removedHidden} more</div>
          )}
        </div>
      )}
    </div>
  );
}
