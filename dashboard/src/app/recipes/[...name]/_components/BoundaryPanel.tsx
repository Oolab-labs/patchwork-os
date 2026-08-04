"use client";

/**
 * Control boundary panel — the dashboard home for `GET /workers/boundary`.
 * Resolves whichever worker owns this recipe and renders what it may do
 * now, what needs a person, and what no approval can unlock. The bridge
 * computes the boundary via `previewActions`/`decideWorkerAction` — the
 * exact functions enforcement uses — so this only renders it (see
 * ControlBoundary's own doc comment for why that matters).
 *
 * `null` from the route means no worker owns this recipe — the honest
 * "nothing to show" answer, rendered as a quiet note rather than an error.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import ControlBoundary, {
  type ActionBoundary,
} from "@/components/ControlBoundary";

interface BoundaryResult {
  workerId: string;
  workerName: string;
  recipeName: string;
  boundary: ActionBoundary;
  /**
   * Whether the worker-autonomy FLAG is on — not a statement that the
   * displayed refusals were themselves enforced. Named for what the bridge
   * actually reports so nobody reads more into it than it says.
   */
  autonomyFlagEnabled: boolean;
  /** Manifest `forbids:` entries that failed to parse and are NOT in force. */
  invalidForbidRules?: number;
}

export function BoundaryPanel({
  recipeName,
  autoRun = false,
}: {
  recipeName: string;
  autoRun?: boolean;
}) {
  const [result, setResult] = useState<BoundaryResult | null>(null);
  const [noWorker, setNoWorker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runBoundary = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNoWorker(false);
    try {
      const res = await fetch(
        apiPath(
          `/api/bridge/workers/boundary?recipe=${encodeURIComponent(recipeName)}`,
        ),
      );
      const data = (await res.json().catch(() => ({}))) as
        | { boundary: BoundaryResult | null }
        | { error?: string; message?: string };
      if (!res.ok || !("boundary" in data)) {
        const msg =
          ("message" in data && data.message) ||
          ("error" in data && data.error) ||
          `HTTP ${res.status}`;
        setError(String(msg));
        setResult(null);
        return;
      }
      if (data.boundary === null) {
        setNoWorker(true);
        setResult(null);
        return;
      }
      setResult(data.boundary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [recipeName]);

  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRun && !autoRanRef.current) {
      autoRanRef.current = true;
      void runBoundary();
    }
  }, [autoRun, runBoundary]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void runBoundary()}
          disabled={busy}
          title="What the owning worker may do now, what needs a person, and what no approval unlocks"
        >
          {busy ? "Resolving…" : "Show control boundary"}
        </button>
        {result && !result.autonomyFlagEnabled && (
          <span
            className="mono"
            style={{ fontSize: "var(--fs-xs)", color: "var(--warn)" }}
          >
            not enforced — worker autonomy flag is off
          </span>
        )}
      </div>

      {result?.invalidForbidRules ? (
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--err)" }}>
          ⚠ {result.invalidForbidRules} forbid rule
          {result.invalidForbidRules === 1 ? "" : "s"} in this worker&apos;s
          manifest could not be parsed and {result.invalidForbidRules === 1 ? "is" : "are"}{" "}
          NOT in force. The list below understates what you intended to forbid.
        </div>
      ) : null}

      {error && (
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--err)" }}>
          Couldn&apos;t resolve the boundary: {error}
        </div>
      )}

      {noWorker && (
        <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>
          — no worker owns this recipe
        </div>
      )}

      {result && (
        <ControlBoundary
          boundary={result.boundary}
          workerName={result.workerName}
        />
      )}
    </div>
  );
}
