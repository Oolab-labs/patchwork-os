"use client";

/**
 * Recipe doctor panel — the dashboard home for the `recipe doctor` CLI.
 * Calls the bridge `GET /recipes/doctor?recipe=<name>` and renders the
 * composed diagnosis: a verdict, the static lint/policy issues, and the
 * recent runtime halts — each halt mapped to the shared fix hint. The
 * bridge owns the composition (single source of truth); this only
 * renders it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import {
  HALT_CATEGORY_HINT,
  HALT_CATEGORY_LABEL,
  type HaltCategory,
} from "@/lib/haltCategory";

interface DoctorStatic {
  ok: boolean;
  recipe: string;
  issues: Array<{
    level: "error" | "warning";
    code: string;
    message: string;
    stepId?: string;
  }>;
  planSkipped?: boolean;
}

interface DoctorRuntime {
  total: number;
  byCategory: Partial<Record<HaltCategory, number>>;
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

export interface DoctorResult {
  recipe: string;
  recipePath: string;
  static: DoctorStatic;
  runtime: DoctorRuntime | null;
  runtimeNote?: string;
  ok: boolean;
}

export function DoctorPanel({
  recipeName,
  autoRun = false,
}: {
  recipeName: string;
  /** Run the diagnosis immediately on mount — used by deep-links
   *  (`?diagnose=1`) from the recipes list and failed-run views. */
  autoRun?: boolean;
}) {
  const [result, setResult] = useState<DoctorResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runDoctor = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        apiPath(
          `/api/bridge/recipes/doctor?recipe=${encodeURIComponent(recipeName)}`,
        ),
      );
      const data = (await res.json().catch(() => ({}))) as
        | DoctorResult
        | { error?: string; message?: string };
      if (!res.ok || !("static" in data)) {
        const msg =
          ("message" in data && data.message) ||
          ("error" in data && data.error) ||
          `HTTP ${res.status}`;
        setError(String(msg));
        setResult(null);
        return;
      }
      setResult(data as DoctorResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [recipeName]);

  // Auto-run once on mount when deep-linked (?diagnose=1). The ref guard
  // keeps it to a single run even if React re-mounts in StrictMode dev.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRun && !autoRanRef.current) {
      autoRanRef.current = true;
      void runDoctor();
    }
  }, [autoRun, runDoctor]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void runDoctor()}
          disabled={busy}
          title="Lint + write-policy + recent runtime halts, with fix hints"
        >
          {busy ? "Diagnosing…" : "Run diagnosis"}
        </button>
        {result && (
          <span
            className="mono"
            style={{
              fontSize: "var(--fs-xs)",
              color: result.ok ? "var(--ok)" : "var(--err)",
            }}
          >
            {result.ok ? "✓ healthy" : "✗ needs attention"}
          </span>
        )}
      </div>

      {error && (
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--err)" }}>
          Couldn&apos;t run diagnosis: {error}
        </div>
      )}

      {result && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
        >
          {/* Static checks */}
          <div>
            <div
              className="mono muted"
              style={{ fontSize: "var(--fs-2xs)", marginBottom: 2 }}
            >
              static checks{result.static.planSkipped ? " (lint-only)" : ""}
            </div>
            {result.static.issues.length === 0 ? (
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--ok)" }}>
                ✓ lint + policy clean
              </div>
            ) : (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 16,
                  fontSize: "var(--fs-xs)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {result.static.issues.map((iss, i) => (
                  <li
                    key={i}
                    style={{
                      color:
                        iss.level === "error" ? "var(--err)" : "var(--warn)",
                      wordBreak: "break-word",
                    }}
                  >
                    {iss.level === "error" ? "✗" : "⚠"} ({iss.code})
                    {iss.stepId ? ` [${iss.stepId}]` : ""} {iss.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Runtime halts */}
          <div>
            <div
              className="mono muted"
              style={{ fontSize: "var(--fs-2xs)", marginBottom: 2 }}
            >
              runtime halts (last 7 days)
            </div>
            {result.runtime === null ? (
              <div
                className="muted"
                style={{ fontSize: "var(--fs-xs)" }}
              >
                — {result.runtimeNote ?? "unavailable"}
              </div>
            ) : result.runtime.total === 0 ? (
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--ok)" }}>
                ✓ none in the recent window
              </div>
            ) : (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 16,
                  fontSize: "var(--fs-xs)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {Object.entries(result.runtime.byCategory)
                  .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                  .map(([cat, count]) => {
                    const category = cat as HaltCategory;
                    return (
                      <li key={cat} style={{ color: "var(--err)" }}>
                        {HALT_CATEGORY_LABEL[category] ?? cat}: {count}
                        <span
                          style={{ color: "var(--accent)", marginLeft: 6 }}
                          title="suggested fix"
                        >
                          → {HALT_CATEGORY_HINT[category] ?? "open run trace"}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
