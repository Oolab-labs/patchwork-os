"use client";

import { useEffect, useState } from "react";

interface HistogramEvent {
  at?: number;
  timestamp?: string;
  kind?: string;
  status?: string;
}

function resolveAt(e: HistogramEvent): number | null {
  if (typeof e.at === "number") return e.at;
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function EventsHistogram({
  events,
  hours = 24,
  height = 48,
  granularity = "hour",
}: {
  events: HistogramEvent[];
  hours?: number;
  height?: number;
  granularity?: "hour" | "minute";
}) {
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); }, []);
  const bucketMs = granularity === "minute" ? 60_000 : 3_600_000;
  const numBuckets = granularity === "minute" ? hours * 60 : hours;

  const buckets = Array.from({ length: numBuckets }, (_, i) => {
    const bucketStart = now - (numBuckets - i) * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    let total = 0;
    let errors = 0;
    for (const e of events) {
      const t = resolveAt(e);
      if (t !== null && t >= bucketStart && t < bucketEnd) {
        total++;
        if (e.status === "error") errors++;
      }
    }
    return { total, errors, bucketStart };
  });

  const maxVal = Math.max(...buckets.map((b) => b.total), 1);
  const barW = 100 / numBuckets;

  // For minute granularity: show ~5 evenly spaced x-axis labels (every 6h = 360 buckets)
  const labelIndices: number[] =
    granularity === "minute"
      ? [0, Math.floor(numBuckets * 0.25), Math.floor(numBuckets * 0.5), Math.floor(numBuckets * 0.75), numBuckets - 1]
      : [0, Math.floor(numBuckets / 2)];

  const labelTimes = labelIndices.map((idx) =>
    now === 0
      ? ""
      : new Date(now - (numBuckets - idx) * bucketMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );

  if (now === 0) return <div style={{ height: height + 16 }} />;

  return (
    <div style={{ position: "relative", height, userSelect: "none" }}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
        aria-label={granularity === "minute" ? "Events per minute, last 24 hours" : "Events per hour, last 24 hours"}
      >
        {buckets.map((b, i) => {
          const barH = Math.max(1, (b.total / maxVal) * (height - 4));
          const x = i * barW;
          const y = height - barH;
          const hasErr = b.errors > 0;
          return (
            <rect
              key={i}
              x={x + 0.3}
              y={y}
              width={Math.max(barW - 0.6, 0.1)}
              height={barH}
              rx={1}
              fill={
                b.total === 0
                  ? "var(--line-3)"
                  : hasErr
                    ? "var(--red)"
                    : "var(--orange)"
              }
              opacity={b.total === 0 ? 0.35 : hasErr ? 0.75 : 0.65}
            >
              <title>
                {now === 0 ? "" : new Date(b.bucketStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {" — "}
                {b.total} event{b.total !== 1 ? "s" : ""}
                {b.errors > 0 ? ` · ${b.errors} error${b.errors !== 1 ? "s" : ""}` : ""}
              </title>
            </rect>
          );
        })}
      </svg>
      {/* x-axis labels */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 3,
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          color: "var(--ink-3)",
        }}
      >
        {granularity === "minute" ? (
          labelTimes.map((label, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static label set
            <span key={i}>{i === labelTimes.length - 1 ? "now" : label}</span>
          ))
        ) : (
          <>
            <span>{labelTimes[0]}</span>
            <span>{labelTimes[1]}</span>
            <span>now</span>
          </>
        )}
      </div>
    </div>
  );
}
