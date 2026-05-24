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
      void probe(controller.signal);
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
    <section aria-labelledby="first-run-heading" className="first-run-checklist">
      <div className="first-run-heading">
        <h2 id="first-run-heading" className="first-run-title">
          Get started{" "}
          <span className="first-run-title-sub">· {doneCount} of 4 done</span>
        </h2>
        <button
          type="button"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          aria-label="Dismiss first-run checklist"
          className="btn sm ghost"
        >
          Dismiss
        </button>
      </div>

      <ol className="first-run-steps">
        {steps.map((s, idx) => {
          const isNext = idx === nextIdx;
          const state = s.step.done ? "done" : isNext ? "next" : "pending";
          return (
            <li
              key={s.n}
              className="first-run-step"
              data-state={state}
            >
              <span aria-hidden="true" className="first-run-step-num">
                {s.step.done ? "✓" : s.n}
              </span>
              <div className="first-run-step-body">
                <div className="first-run-step-label">
                  {s.label}
                  {isNext && (
                    <span className="first-run-next-badge">← next</span>
                  )}
                </div>
                {(() => {
                  const tip = s.step.done ? s.step.doneHint : s.step.hint;
                  if (!tip) return null;
                  return <div className="first-run-step-tip">{tip}</div>;
                })()}
              </div>
              {!s.step.done && (
                <Link href={s.cta.href} className="first-run-step-cta">
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
