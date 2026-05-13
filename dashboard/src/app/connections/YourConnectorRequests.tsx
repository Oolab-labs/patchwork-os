"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

/**
 * Lists the user's previously-submitted connector requests on
 * /connections. Plumbing audit (2026-05-12) found the request form
 * was write-only — submitted requests vanished into
 * ~/.patchwork/connector-requests.json with no way to see them again.
 *
 * Pairs with the GET handler added to /api/connector-requests:
 *   - empty list -> render nothing (no noise for fresh installs)
 *   - non-empty -> compact list, newest first, with relative time
 *   - fetch error -> render nothing (best-effort; the connections
 *     page is the primary surface and we don't want a sub-panel
 *     fail to break the page)
 */

interface ConnectorRequest {
  name: string;
  notes?: string;
  requestedAt: string;
}

function relTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function YourConnectorRequests() {
  const [requests, setRequests] = useState<ConnectorRequest[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiPath("/api/connector-requests"));
        if (!res.ok) return;
        const data = (await res.json()) as { requests?: ConnectorRequest[] };
        if (cancelled) return;
        setRequests(Array.isArray(data.requests) ? data.requests : []);
      } catch {
        /* read is best-effort */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || requests.length === 0) return null;

  return (
    <section
      aria-labelledby="your-requests-heading"
      style={{
        marginBottom: "var(--s-4)",
        padding: "12px 16px",
        borderRadius: "var(--r-2)",
        border: "1px solid var(--line-2)",
        background: "var(--recess)",
      }}
    >
      <h2
        id="your-requests-heading"
        style={{
          margin: 0,
          fontSize: "var(--fs-s)",
          fontWeight: 600,
          color: "var(--ink-2)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Your connector requests{" "}
        <span style={{ color: "var(--ink-3)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          · {requests.length}
        </span>
      </h2>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "8px 0 0",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {requests.map((r, i) => (
          <li
            key={`${r.requestedAt}-${i}`}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              fontSize: "var(--fs-s)",
              color: "var(--ink-2)",
            }}
          >
            <strong style={{ color: "var(--ink-1)", fontWeight: 600 }}>{r.name}</strong>
            {r.notes && (
              <span
                style={{
                  color: "var(--ink-3)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
                title={r.notes}
              >
                — {r.notes}
              </span>
            )}
            <span
              style={{
                color: "var(--ink-3)",
                fontSize: "var(--fs-xs)",
                flexShrink: 0,
                marginLeft: "auto",
              }}
            >
              {relTime(r.requestedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
