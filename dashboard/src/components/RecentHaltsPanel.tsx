"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { Glossary } from "@/components/patchwork";
import {
  type HaltCategory,
  type HaltSummary,
  HALT_CATEGORY_LABEL,
} from "@/lib/haltCategory";

/**
 * "Recent halts (24h)" panel for /activity.
 *
 * The sidebar's Activity nav item carries a halt-count badge that polls
 * /runs/halt-summary every 60s. Before this panel, clicking the badge
 * landed on /activity where halts were never mentioned — the badge
 * promised data the page didn't deliver. The plumbing audit identified
 * this as the highest-impact "hidden gem" surface gap.
 *
 * Renders nothing when there are no halts in the window (don't add
 * noise to an otherwise-quiet page).
 */

const SINCE_24H_MS = 24 * 60 * 60 * 1000;

export function RecentHaltsPanel() {
  const [summary, setSummary] = useState<HaltSummary | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          apiPath(`/api/bridge/runs/halt-summary?sinceMs=${SINCE_24H_MS}`),
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HaltSummary;
        if (!cancelled) {
          setSummary(data);
          setErrored(false);
        }
      } catch {
        if (!cancelled) setErrored(true);
      }
    };
    void load();
    // Slower than the run-list (30s) — halts are post-hoc; no urgency.
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Collapse to nothing when the bridge is offline or the window is
  // genuinely quiet. The sidebar badge will be zero in either case, so
  // the user has no reason to expect a panel here.
  if (errored || !summary || summary.total === 0) return null;

  const topCategories = (
    Object.entries(summary.byCategory) as Array<[HaltCategory, number]>
  )
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const recent = summary.recent.slice(0, 5);

  return (
    <section
      aria-labelledby="recent-halts-heading"
      style={{
        marginBottom: "var(--s-4)",
        padding: "14px 18px",
        borderRadius: "var(--r-3)",
        border: "1px solid color-mix(in srgb, var(--amber) 28%, transparent)",
        background: "color-mix(in srgb, var(--amber) 6%, var(--surface))",
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
          id="recent-halts-heading"
          style={{
            margin: 0,
            fontSize: "var(--fs-m)",
            fontWeight: 600,
            color: "var(--ink-1)",
          }}
        >
          Recent <Glossary term="halt">halts</Glossary>{" "}
          <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>· last 24h</span>
        </h2>
        <Link
          href="/runs"
          style={{
            fontSize: "var(--fs-xs)",
            color: "var(--ink-2)",
            textDecoration: "none",
          }}
        >
          {summary.total} halt{summary.total === 1 ? "" : "s"} →
        </Link>
      </div>

      {topCategories.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginTop: 8,
          }}
          aria-label="Halt categories"
        >
          {topCategories.map(([cat, n]) => (
            <span
              key={cat}
              style={{
                fontSize: "var(--fs-xs)",
                padding: "2px 9px",
                borderRadius: 999,
                border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
                background: "transparent",
                color: "var(--ink-2)",
              }}
            >
              {HALT_CATEGORY_LABEL[cat]} <strong style={{ color: "var(--ink-1)" }}>{n}</strong>
            </span>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <ul
          aria-label="Most recent halts"
          style={{
            listStyle: "none",
            padding: 0,
            margin: "10px 0 0",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {recent.map((h) => (
            <li
              key={h.runSeq}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                fontSize: "var(--fs-s)",
              }}
            >
              <Link
                href={`/runs/${h.runSeq}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-2)",
                  textDecoration: "none",
                  flexShrink: 0,
                }}
              >
                #{h.runSeq}
              </Link>
              <span style={{ color: "var(--ink-3)", flexShrink: 0 }}>
                {HALT_CATEGORY_LABEL[h.category]}
              </span>
              <span
                style={{
                  color: "var(--ink-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={h.reason}
              >
                {h.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
