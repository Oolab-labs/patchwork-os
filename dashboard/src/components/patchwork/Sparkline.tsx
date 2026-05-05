"use client";
import { useEffect, useId, useRef, useState } from "react";

export function Sparkline({
  values,
  color = "var(--orange)",
  height = 36,
}: {
  values: number[];
  color?: string;
  height?: number;
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
  const [len, setLen] = useState(0);
  useEffect(() => {
    if (pathRef.current) {
      try {
        setLen(pathRef.current.getTotalLength());
      } catch {
        setLen(0);
      }
    }
  }, [values]);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
      aria-hidden="true"
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
      <style>{"@keyframes spark-draw { to { stroke-dashoffset: 0; } }"}</style>
    </svg>
  );
}
