"use client";
/**
 * StepDiffHover — popover that shows a step's registry-diff plus its
 * resolvedParams + output. Used by `/runs/[seq]` page on row hover.
 *
 * Anchors to the parent row (caller positions via wrapping div). Closes
 * on Escape, click-outside, or `mouseleave` from the wrapper.
 *
 * Caps to 50 changes shown + "and N more" so a step that adds 200 keys
 * doesn't blow up the layout.
 */

import { useEffect, useRef } from "react";
import {
  type RegistryDiff,
  changeCount,
} from "@/lib/registryDiff";

const MAX_ROWS_PER_SECTION = 50;
const MAX_VALUE_PREVIEW_CHARS = 200;

function previewValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > MAX_VALUE_PREVIEW_CHARS
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
  diff: RegistryDiff | null;
  resolvedParams?: unknown;
  output?: unknown;
  onClose: () => void;
}

export function StepDiffHover({
  diff,
  resolvedParams,
  output,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Diff = null ⇒ pre-VD-2 row or runner without capture. Show graceful
  // empty state instead of nothing.
  if (!diff) {
    return (
      <div ref={ref} className="step-diff-hover" role="dialog" aria-label="Step detail">
        <div className="step-diff-section step-diff-empty">
          Step capture unavailable for this run (pre-VD-2 or non-bridge run).
        </div>
      </div>
    );
  }

  const totalChanges = changeCount(diff);
  const addedKeys = Object.keys(diff.added);
  const addedShown = addedKeys.slice(0, MAX_ROWS_PER_SECTION);
  const addedHidden = addedKeys.length - addedShown.length;
  const modifiedShown = diff.modified.slice(0, MAX_ROWS_PER_SECTION);
  const modifiedHidden = diff.modified.length - modifiedShown.length;
  const removedShown = diff.removed.slice(0, MAX_ROWS_PER_SECTION);
  const removedHidden = diff.removed.length - removedShown.length;

  return (
    <div ref={ref} className="step-diff-hover" role="dialog" aria-label="Step detail">
      {/* Resolved params */}
      {resolvedParams !== undefined && (
        <div className="step-diff-section">
          <div className="step-diff-heading">Resolved params</div>
          <div className="step-diff-value mono">{previewValue(resolvedParams)}</div>
        </div>
      )}

      {/* Output */}
      {output !== undefined && (
        <div className="step-diff-section">
          <div className="step-diff-heading">Output</div>
          <div className="step-diff-value mono">{previewValue(output)}</div>
        </div>
      )}

      {/* Registry diff */}
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
    </div>
  );
}
