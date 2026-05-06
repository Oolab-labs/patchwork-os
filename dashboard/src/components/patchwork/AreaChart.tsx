"use client";

import { useMemo } from "react";

export interface AreaChartSeries {
  values: number[];
  color?: string;
  label?: string;
}

const DEFAULT_COLORS = [
  "var(--orange)",
  "var(--blue)",
  "var(--green)",
  "var(--red)",
];

const PAD = { top: 8, right: 8, bottom: 22, left: 36 };

/**
 * Responsive area chart.
 *
 * Why labels render as HTML overlay instead of <text> inside the SVG:
 * the SVG uses preserveAspectRatio="none" so curves fill the container
 * regardless of width. <text> inside that SVG would stretch
 * anisotropically, mashing y-axis numerals and pinching x-axis times.
 * HTML overlay keeps text rendering at native pixel density.
 */
export function AreaChart({
  series,
  xLabels,
  height = 120,
  yTicks = 4,
}: {
  series: AreaChartSeries[];
  xLabels?: string[];
  height?: number;
  yTicks?: number;
}) {
  const { maxVal, n, tickVals, paths } = useMemo(() => {
    const allVals = series.flatMap((s) => s.values);
    const rawMax = Math.max(...allVals, 0);
    const nice = niceCeiling(rawMax);
    const length = Math.max(...series.map((s) => s.values.length), 2);
    const ticks = Array.from({ length: yTicks }, (_, i) =>
      Math.round((nice / (yTicks - 1)) * i),
    );
    return {
      maxVal: nice,
      n: length,
      tickVals: ticks,
      paths: series.map((s) => buildPath(s.values, length, nice, height)),
    };
  }, [series, yTicks, height]);

  const colors = series.map((s, i) => s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]);

  // SR-only summary so the chart has an accessible name.
  const summary = series
    .filter((s) => s.label)
    .map((s) => {
      const total = s.values.reduce((a, b) => a + b, 0);
      const peak = Math.max(...s.values, 0);
      return `${s.label}: ${total} total, peak ${peak}`;
    })
    .join("; ");

  const xTicks = (xLabels ?? [])
    .map((lbl, i) => ({ lbl, i }))
    .filter(({ lbl }) => lbl.length > 0);

  return (
    <figure
      role="img"
      aria-label={summary || "area chart"}
      style={{
        position: "relative",
        width: "100%",
        height,
        margin: 0,
      }}
    >
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
        }}
        aria-hidden="true"
      >
        <defs>
          {series.map((_, si) => (
            <linearGradient key={si} id={`acGrad${si}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={colors[si]} stopOpacity="0.28" />
              <stop offset="100%" stopColor={colors[si]} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* gridlines */}
        {tickVals.map((v, i) => {
          const y =
            PAD.top +
            (height - PAD.top - PAD.bottom) * (1 - v / Math.max(maxVal, 1));
          return (
            <line
              key={`tick-${i}-${v}`}
              x1={0}
              x2={100}
              y1={y}
              y2={y}
              stroke="var(--line-2)"
              strokeWidth={0.4}
              strokeDasharray={v === 0 ? undefined : "1 1.5"}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* series */}
        {series.map((s, si) => {
          const { line, area } = paths[si];
          if (!line) return null;
          return (
            <g key={si}>
              <path d={area} fill={`url(#acGrad${si})`} />
              <path
                d={line}
                fill="none"
                stroke={colors[si]}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>

      {/* y-axis labels (HTML overlay) */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: PAD.left,
          height: "100%",
          pointerEvents: "none",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-2xs)",
          color: "var(--ink-3)",
        }}
      >
        {tickVals.map((v, i) => {
          const pct =
            ((PAD.top + (height - PAD.top - PAD.bottom) * (1 - v / Math.max(maxVal, 1))) /
              height) *
            100;
          return (
            <span
              key={`tick-${i}-${v}`}
              style={{
                position: "absolute",
                top: `${pct}%`,
                right: 4,
                transform: "translateY(-50%)",
                whiteSpace: "nowrap",
              }}
            >
              {v}
            </span>
          );
        })}
      </div>

      {/* x-axis labels (HTML overlay) */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: PAD.left,
          right: PAD.right,
          bottom: 2,
          height: PAD.bottom - 4,
          pointerEvents: "none",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-2xs)",
          color: "var(--ink-3)",
        }}
      >
        {xTicks.map(({ lbl, i }) => {
          const pct = (i / Math.max(n - 1, 1)) * 100;
          const isFirst = i === 0;
          const isLast = i === n - 1;
          return (
            <span
              key={`${i}-${lbl}`}
              style={{
                position: "absolute",
                left: `${pct}%`,
                transform: isLast
                  ? "translateX(-100%)"
                  : isFirst
                    ? "translateX(0)"
                    : "translateX(-50%)",
                whiteSpace: "nowrap",
              }}
            >
              {lbl}
            </span>
          );
        })}
      </div>
    </figure>
  );
}

function buildPath(
  values: number[],
  n: number,
  maxVal: number,
  height: number,
): { line: string; area: string } {
  if (values.length < 2) return { line: "", area: "" };
  const safeMax = Math.max(maxVal, 1);
  const yTop = PAD.top;
  const yBottom = height - PAD.bottom;
  const chartH = yBottom - yTop;

  const pts = values.map((v, i) => {
    const x = (i / Math.max(n - 1, 1)) * 100;
    const y = yTop + chartH - (v / safeMax) * chartH;
    return [x, y] as const;
  });

  const line = pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  if (!last || !first) return { line: "", area: "" };
  const area = `${line} L${last[0]},${yBottom} L${first[0]},${yBottom} Z`;
  return { line, area };
}

function niceCeiling(n: number): number {
  if (n <= 0) return 1;
  if (n < 5) return Math.ceil(n);
  if (n < 10) return Math.ceil(n / 2) * 2;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const norm = n / base;
  let rounded: number;
  if (norm <= 1) rounded = 1;
  else if (norm <= 2) rounded = 2;
  else if (norm <= 5) rounded = 5;
  else rounded = 10;
  return rounded * base;
}
