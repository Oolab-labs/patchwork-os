"use client";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Last-N-buckets line chart. Used as a passive ornament on tiles
 * (Runs · 24h, Halts · 24h). When a `labels` prop is supplied the
 * sparkline becomes hover-interactive: a vertical cursor + readout
 * tracks the pointer's nearest bucket, so the curve also functions
 * as a tiny per-bucket inspector. Without labels the curve is purely
 * decorative — keeping the inspector opt-in avoids surprise hit-
 * targets on tiles whose foot already carries a static label.
 */
export function Sparkline({
  values,
  color = "var(--orange)",
  height = 36,
  labels,
  unit = "",
}: {
  values: number[];
  color?: string;
  height?: number;
  /** Per-bucket label (e.g. "Mon", "Tue", ..., "today"). Enables hover inspector. */
  labels?: string[];
  /** Trailing unit suffix on the readout, e.g. "runs". */
  unit?: string;
}) {
  const w = 200;
  const h = height;
  const safe = values.length >= 2 ? values : [0, 0];
  const max = Math.max(...safe);
  const min = Math.min(...safe);
  const range = max - min || 1;
  const pts = safe.map((v, i) => {
    const x = (i / (safe.length - 1)) * w;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const id = useId().replace(/:/g, "");
  const pathRef = useRef<SVGPathElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [len, setLen] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  useEffect(() => {
    if (pathRef.current) {
      try {
        setLen(pathRef.current.getTotalLength());
      } catch {
        setLen(0);
      }
    }
  }, [values]);

  const interactive = Array.isArray(labels) && labels.length === safe.length;

  function handlePointer(ev: React.PointerEvent<SVGSVGElement>) {
    if (!interactive || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = (ev.clientX - rect.left) / rect.width;
    const idx = Math.max(
      0,
      Math.min(safe.length - 1, Math.round(ratio * (safe.length - 1))),
    );
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
        role={interactive ? "img" : undefined}
        aria-label={interactive ? `Per-${labels?.length}-bucket sparkline` : undefined}
        onPointerMove={interactive ? handlePointer : undefined}
        onPointerLeave={interactive ? () => setHoverIdx(null) : undefined}
      >
        <defs>
          <linearGradient id={`sparkGrad-${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#sparkGrad-${id})`} />
        <path
          ref={pathRef}
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: len || undefined,
            strokeDashoffset: len || undefined,
            animation: len ? "spark-draw 1.4s cubic-bezier(.2,.7,.2,1) forwards" : undefined,
          }}
        />
        {interactive && hoverIdx != null && (
          <>
            <line
              x1={pts[hoverIdx][0]}
              x2={pts[hoverIdx][0]}
              y1={0}
              y2={h}
              stroke={color}
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity={0.55}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={pts[hoverIdx][0]}
              cy={pts[hoverIdx][1]}
              r="2.5"
              fill={color}
            />
          </>
        )}
      </svg>
      {interactive && hoverIdx != null && labels && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -22,
            left: `${(hoverIdx / (safe.length - 1)) * 100}%`,
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
            boxShadow: "0 2px 6px -2px rgba(0,0,0,0.18)",
          }}
        >
          {labels[hoverIdx]} · <b style={{ color }}>{safe[hoverIdx]}</b>
          {unit ? ` ${unit}` : ""}
        </div>
      )}
    </div>
  );
}
