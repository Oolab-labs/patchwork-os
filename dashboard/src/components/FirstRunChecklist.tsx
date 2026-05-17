"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

/**
 * Four-step "first run" orchestration shown on /dashboard for users
 * whose workspace hasn't yet seen the full happy path. Each step
 * auto-checks against a real bridge endpoint:
 *
 *   1. Connect a service        — `/api/bridge/connections` has any entry
 *   2. Install / create a recipe — `/api/bridge/recipes` returns >= 1
 *   3. Run it                    — `/api/bridge/runs` returns >= 1
 *   4. Approve when prompted     — `/api/bridge/approvals/history` has >= 1
 *
 * Strategic-critique gap: "What does a brand-new user see when /tasks,
 * /recipes, /activity are all empty? Today: 15 unstructured empty-
 * state divs, no orchestration." This component is the orchestration.
 *
 * Collapses (renders null) when:
 *   - all 4 steps are complete (the happy path is established)
 *   - the user has dismissed it
 *
 * Dismissals persist in localStorage. A "Restore checklist" mechanic
 * is intentionally NOT here — Settings is the natural place for that,
 * filed for a follow-up commit.
 */

const STORAGE_KEY = "patchwork.firstRun.dismissed";

interface StepStatus {
  done: boolean;
  /** One-line nudge surfaced when the step is incomplete — "do this next". */
  hint?: string;
  /** One-line follow-on surfaced when the step is done — "what good looks like". */
  doneHint?: string;
}

interface Status {
  connections: StepStatus;
  recipes: StepStatus;
  runs: StepStatus;
  approvals: StepStatus;
  loaded: boolean;
}

function emptyStatus(): Status {
  return {
    connections: { done: false },
    recipes: { done: false },
    runs: { done: false },
    approvals: { done: false },
    loaded: false,
  };
}

async function probeArray(
  path: string,
  key?: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const res = await fetch(apiPath(path), { ...(signal && { signal }) });
    if (!res.ok) return 0;
    const data = (await res.json()) as unknown;
    const arr = key
      ? ((data as Record<string, unknown>)?.[key] as unknown[] | undefined)
      : (data as unknown[]);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}

export function FirstRunChecklist() {
  const [status, setStatus] = useState<Status>(emptyStatus);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const probe = useCallback(async (signal?: AbortSignal) => {
    // Probe all 5 endpoints in parallel — cheap reads, brand-new
    // workspace is the hot path. Endpoint shapes (verified against
    // the live bridge):
    //   /connections                       -> { connectors: [...] }
    //   /recipes                           -> { recipes: [...] }
    //   /runs                              -> { runs: [...] }
    //   /approvals                         -> [...] (pending queue)
    //   /traces?traceType=approval         -> { traces: [...] }
    // Step 4 is satisfied if EITHER an approval is currently pending
    // (the user is mid-flow) OR an approval trace was ever saved (the
    // user has been through the flow at least once).
    const [conn, recipes, runs, pendingApprovals, approvalTraces] =
      await Promise.all([
        probeArray("/api/bridge/connections", "connectors", signal),
        probeArray("/api/bridge/recipes", "recipes", signal),
        probeArray("/api/bridge/runs", "runs", signal),
        probeArray("/api/bridge/approvals", undefined, signal),
        probeArray("/api/bridge/traces?traceType=approval", "traces", signal),
      ]);
    if (signal?.aborted) return;
    setStatus({
      connections: {
        done: conn > 0,
        hint: "Gmail, Slack, or any HTTP API. Credentials stay in ~/.patchwork.",
        doneHint: "Add more in /connections — one recipe can fan across services.",
      },
      recipes: {
        done: recipes > 0,
        hint: "Browse the marketplace or scaffold one with patchwork recipe new.",
        doneHint: "YAML lives in ~/.patchwork/recipes. Tweak triggers and steps in /recipes.",
      },
      runs: {
        done: runs > 0,
        hint: "Hit Run on any recipe, or wait for a scheduled trigger.",
        doneHint: "Watch live in /activity. Halts and errors land in /runs.",
      },
      approvals: {
        done: pendingApprovals > 0 || approvalTraces > 0,
        hint: "Nothing leaves your machine without a nod. The queue is in /approvals.",
        doneHint: "Approval patterns in /insights surface what's safe to auto-approve.",
      },
      loaded: true,
    });
  }, []);

  useEffect(() => {
    // #605: own per-tick AbortController so unmount cancels in-flight
    // probes (and the 5 parallel probeArray fetches inside).
    const controller = new AbortController();
    void probe(controller.signal);
    // Refresh every 30s — the checklist auto-completes as the user
    // works through it, so polling makes the green checkmarks appear
    // without a reload. Each tick gets its own controller so per-tick
    // abort doesn't kill all future ticks.
    const id = setInterval(() => {
      const tickCtrl = new AbortController();
      void probe(tickCtrl.signal);
    }, 30_000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [probe]);

  if (dismissed) return null;
  if (!status.loaded) return null;
  const allDone =
    status.connections.done &&
    status.recipes.done &&
    status.runs.done &&
    status.approvals.done;
  if (allDone) return null;
  const doneCount =
    (status.connections.done ? 1 : 0) +
    (status.recipes.done ? 1 : 0) +
    (status.runs.done ? 1 : 0) +
    (status.approvals.done ? 1 : 0);

  const steps: Array<{
    n: number;
    label: string;
    cta: { href: string; label: string };
    step: StepStatus;
  }> = [
    {
      n: 1,
      label: "Connect a service",
      cta: { href: "/connections", label: "Connect →" },
      step: status.connections,
    },
    {
      n: 2,
      label: "Install or create a recipe",
      cta: { href: "/marketplace", label: "Browse marketplace →" },
      step: status.recipes,
    },
    {
      n: 3,
      label: "Run it",
      cta: { href: "/recipes", label: "Open recipes →" },
      step: status.runs,
    },
    {
      n: 4,
      label: "Approve when prompted",
      cta: { href: "/approvals", label: "See queue →" },
      step: status.approvals,
    },
  ];

  return (
    <section
      aria-labelledby="first-run-heading"
      style={{
        marginBottom: "var(--s-5)",
        padding: "16px 20px",
        borderRadius: "var(--r-3)",
        border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
        background: "color-mix(in srgb, var(--accent) 5%, var(--surface))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h2
          id="first-run-heading"
          style={{
            margin: 0,
            fontSize: "var(--fs-m)",
            fontWeight: 600,
            color: "var(--ink-1)",
          }}
        >
          Get started{" "}
          <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
            · {doneCount} of 4 done
          </span>
        </h2>
        <button
          type="button"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          aria-label="Dismiss first-run checklist"
          style={{
            background: "transparent",
            border: "1px solid var(--line-2)",
            color: "var(--ink-3)",
            padding: "3px 10px",
            borderRadius: "var(--r-2)",
            fontSize: "var(--fs-xs)",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      </div>

      <ol
        style={{
          listStyle: "none",
          padding: 0,
          margin: "12px 0 0",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {steps.map((s) => (
          <li
            key={s.n}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 12px",
              borderRadius: "var(--r-2)",
              background: s.step.done
                ? "color-mix(in srgb, var(--green) 7%, transparent)"
                : "var(--recess)",
              opacity: s.step.done ? 0.65 : 1,
              transition: "opacity 180ms, background 180ms",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: s.step.done ? "var(--green)" : "transparent",
                border: s.step.done
                  ? "1px solid var(--green)"
                  : "1px solid var(--line-2)",
                color: s.step.done ? "var(--on-accent, #fff)" : "var(--ink-3)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "var(--fs-xs)",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {s.step.done ? "✓" : s.n}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "var(--fs-s)",
                  fontWeight: 500,
                  color: "var(--ink-1)",
                  textDecoration: s.step.done ? "line-through" : "none",
                }}
              >
                {s.label}
              </div>
              {(() => {
                const tip = s.step.done ? s.step.doneHint : s.step.hint;
                if (!tip) return null;
                return (
                  <div
                    style={{
                      fontSize: "var(--fs-xs)",
                      color: "var(--ink-3)",
                      marginTop: 2,
                    }}
                  >
                    {tip}
                  </div>
                );
              })()}
            </div>
            {!s.step.done && (
              <Link
                href={s.cta.href}
                style={{
                  fontSize: "var(--fs-xs)",
                  fontWeight: 600,
                  color: "var(--accent)",
                  textDecoration: "none",
                  flexShrink: 0,
                }}
              >
                {s.cta.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
