"use client";
import { useId, useRef, useState } from "react";
import type React from "react";

/**
 * Vertical bar chart for stat card feet. Same responsive SVG approach
 * as Sparkline but renders solid bars instead of a line area — matches
 * the Kilo-style "activity histogram" shape on telemetry tiles.
 */
export function MiniBarChart({
  values,
  color = "var(--accent-cool, #0787ff)",
  height = 28,
  labels,
  unit = "",
}: {
  values: number[];
  color?: string;
  height?: number;
  labels?: string[];
  unit?: string;
}) {
  const n = Math.max(values.length, 1);
  const slotW = 10;
  const barW = 7;
  const w = n * slotW;
  const h = height;
  const max = Math.max(...values, 1);
  const id = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const interactive = Array.isArray(labels) && labels.length === values.length;

  function handlePointer(ev: React.PointerEvent<SVGSVGElement>) {
    if (!interactive || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = (ev.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(n - 1, Math.floor(ratio * n)));
    setHoverIdx(idx);
  }

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{
          width: "100%",
          height,
          display: "block",
          cursor: interactive ? "crosshair" : "default",
        }}
        aria-hidden={!interactive}
        onPointerMove={interactive ? handlePointer : undefined}
        onPointerLeave={interactive ? () => setHoverIdx(null) : undefined}
      >
        <defs>
          <linearGradient id={`bar-grad-${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.9" />
            <stop offset="100%" stopColor={color} stopOpacity="0.5" />
          </linearGradient>
        </defs>
        {values.map((v, i) => {
          const barH = v === 0 ? 0 : Math.max(2, Math.round((v / max) * (h - 4)));
          if (barH === 0) return null;
          const x = i * slotW + (slotW - barW) / 2;
          return (
            <rect
              key={i}
              x={x}
              y={h - barH}
              width={barW}
              height={barH}
              rx="2"
              fill={`url(#bar-grad-${id})`}
              opacity={hoverIdx === i ? 1 : 0.72}
            />
          );
        })}
      </svg>
      {interactive && hoverIdx != null && labels && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -22,
            left: `${((hoverIdx + 0.5) / n) * 100}%`,
            transform: "translateX(-50%)",
            fontSize: "var(--fs-2xs)",
            fontFamily: "var(--font-mono)",
            color: "var(--ink-1)",
            background: "var(--surface)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-sm)",
            padding: "1px 6px",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {labels[hoverIdx]} · <b style={{ color }}>{values[hoverIdx]}</b>
          {unit ? ` ${unit}` : ""}
        </div>
      )}
    </div>
  );
}
