"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

/**
 * First-run funnel shown on /dashboard for users who haven't yet seen the
 * full happy path. Steps are ordered by the natural onboarding sequence:
 *
 *   1. Install or create a recipe  — `/api/bridge/recipes` returns >= 1
 *   2. Run it                       — `/api/bridge/runs` returns >= 1
 *   3. See a result in inbox        — `/api/bridge/inbox` returns >= 1 item
 *   4. Connect a service            — `/api/bridge/connections` has any entry
 *
 * The "next" step (first incomplete one) is visually emphasised so the
 * user always knows what to do next.
 *
 * Collapses (renders null) when:
 *   - all steps are complete (the happy path is established)
 *   - the user has dismissed it
 *
 * Dismissals persist in localStorage.
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
  inbox: StepStatus;
  loaded: boolean;
}

function emptyStatus(): Status {
  return {
    connections: { done: false },
    recipes: { done: false },
    runs: { done: false },
    inbox: { done: false },
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
    const [recipes, runs, inboxItems, conn] = await Promise.all([
      probeArray("/api/bridge/recipes", "recipes", signal),
      probeArray("/api/bridge/runs", "runs", signal),
      probeArray("/api/bridge/inbox", "items", signal),
      probeArray("/api/bridge/connections", "connectors", signal),
    ]);
    if (signal?.aborted) return;
    setStatus({
      recipes: {
        done: recipes > 0,
        hint: "Browse the marketplace or scaffold one with patchwork recipe new.",
        doneHint:
          "YAML lives in ~/.patchwork/recipes. Tweak triggers and steps in /recipes.",
      },
      runs: {
        done: runs > 0,
        hint: "Hit Run on any recipe, or wait for a scheduled trigger.",
        doneHint: "Watch live in /runs. Halts and errors appear there too.",
      },
      inbox: {
        done: inboxItems > 0,
        hint: "After a recipe run, results land here as inbox items.",
        doneHint:
          "Inbox delivers briefs. Set up phone delivery so results reach you anywhere.",
      },
      connections: {
        done: conn > 0,
        hint: "Gmail, Slack, or any HTTP API. Credentials stay in ~/.patchwork.",
        doneHint:
          "Add more in /connections — one recipe can fan across services.",
      },
      loaded: true,
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void probe(controller.signal);
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
    status.recipes.done &&
    status.runs.done &&
    status.inbox.done &&
    status.connections.done;
  if (allDone) return null;

  const doneCount =
    (status.recipes.done ? 1 : 0) +
    (status.runs.done ? 1 : 0) +
    (status.inbox.done ? 1 : 0) +
    (status.connections.done ? 1 : 0);

  const steps: Array<{
    n: number;
    label: string;
    cta: { href: string; label: string };
    step: StepStatus;
  }> = [
    {
      n: 1,
      label: "Install or create a recipe",
      cta: { href: "/marketplace", label: "Browse marketplace →" },
      step: status.recipes,
    },
    {
      n: 2,
      label: "Run a recipe",
      cta: { href: "/recipes", label: "Open recipes →" },
      step: status.runs,
    },
    {
      n: 3,
      label: "See a result in your inbox",
      cta: { href: "/inbox", label: "Open inbox →" },
      step: status.inbox,
    },
    {
      n: 4,
      label: "Connect a service",
      cta: { href: "/connections", label: "Connect →" },
      step: status.connections,
    },
  ];

  // Index of the first incomplete step — this is the "next" step.
  const nextIdx = steps.findIndex((s) => !s.step.done);

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
        {steps.map((s, idx) => {
          const isNext = idx === nextIdx;
          return (
            <li
              key={s.n}
              data-next={isNext ? "true" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 12px",
                borderRadius: "var(--r-2)",
                background: s.step.done
                  ? "color-mix(in srgb, var(--green) 7%, transparent)"
                  : isNext
                    ? "color-mix(in srgb, var(--accent) 8%, var(--recess))"
                    : "var(--recess)",
                opacity: s.step.done ? 0.65 : 1,
                outline: isNext
                  ? "1.5px solid color-mix(in srgb, var(--accent) 35%, transparent)"
                  : "none",
                transition: "opacity 180ms, background 180ms",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: s.step.done
                    ? "var(--green)"
                    : isNext
                      ? "var(--accent)"
                      : "transparent",
                  border: s.step.done
                    ? "1px solid var(--green)"
                    : isNext
                      ? "1px solid var(--accent)"
                      : "1px solid var(--line-2)",
                  color:
                    s.step.done || isNext
                      ? "var(--on-accent, #fff)"
                      : "var(--ink-3)",
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
                    fontWeight: isNext ? 600 : 500,
                    color: "var(--ink-1)",
                    textDecoration: s.step.done ? "line-through" : "none",
                  }}
                >
                  {s.label}
                  {isNext && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "var(--fs-xs)",
                        fontWeight: 600,
                        color: "var(--accent)",
                        verticalAlign: "middle",
                      }}
                    >
                      ← next
                    </span>
                  )}
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
          );
        })}
      </ol>
    </section>
  );
}
