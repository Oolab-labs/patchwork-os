"use client";

/**
 * The most recent gate decision for a worker, in the gate's own words.
 *
 * The prose is produced by the BRIDGE (`formatGateDecisionHistory`, the same
 * function `patchwork gate explain` prints) and rendered here verbatim. It is
 * deliberately not re-formatted, re-ordered or summarised on this side.
 *
 * The dashboard shares no code with the bridge, so a second formatter would be
 * a second opinion — and the two would eventually disagree about what a
 * decision meant. That is intolerable in the one artefact whose stated value is
 * that a person can read it and see what happened, without running our
 * software. Rendering someone else's sentences is the point, not a shortcut.
 */

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

interface Props {
  workerId: string;
}

type State =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ready"; text: string }
  | { kind: "error"; message: string };

export function DecisionReceipt({ workerId }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          apiPath(
            `/api/bridge/gate/decisions?workerId=${encodeURIComponent(workerId)}&limit=1&explain=1`,
          ),
        );
        const data = (await res.json().catch(() => ({}))) as {
          decisions?: unknown[];
          explanation?: string;
        };
        if (cancelled) return;
        const text = data.explanation?.trim();
        // No decisions is a real, common answer — a worker that has not acted
        // yet. Reported as such rather than as an empty box, which would read
        // as "nothing to see" when it means "nothing has happened".
        setState(
          text ? { kind: "ready", text } : { kind: "none" },
        );
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workerId]);

  if (state.kind === "loading") return null;

  return (
    <div style={{ marginTop: "var(--s-3)" }}>
      <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
        <strong>The last decision, in the gate&rsquo;s own words</strong>
      </div>
      {state.kind === "none" ? (
        <div className="editorial-sub">
          No gate decision has been recorded for this worker yet — it has not
          acted on a gated action-class, or worker autonomy is off.
        </div>
      ) : state.kind === "error" ? (
        <div className="editorial-sub">
          Could not read the decision record: {state.message}
        </div>
      ) : (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            overflowX: "auto",
            fontSize: "0.85em",
            lineHeight: 1.5,
            margin: "var(--s-2) 0 0",
            padding: "var(--s-2)",
            background: "var(--surface-2)",
            borderRadius: 4,
          }}
        >
          {state.text}
        </pre>
      )}
    </div>
  );
}

export default DecisionReceipt;
