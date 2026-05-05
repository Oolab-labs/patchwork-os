export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

function polarToCart(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  if (endDeg - startDeg >= 360) endDeg = startDeg + 359.99;
  const s = polarToCart(cx, cy, r, startDeg);
  const e = polarToCart(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

export function MetricsDonut({
  segments,
  size = 120,
  strokeWidth = 18,
  label,
}: {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  label?: string;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) {
    return (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>no data</span>
      </div>
    );
  }

  const cx = 50, cy = 50, r = 35;
  let cursor = 0;
  const arcs = segments.map((seg) => {
    const span = (seg.value / total) * 360;
    const start = cursor;
    cursor += span;
    return { ...seg, start, end: cursor };
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ flexShrink: 0 }}>
        {/* track */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--line-3)" strokeWidth={strokeWidth} />
        {arcs.map((arc, i) => (
          <path
            key={i}
            d={arcPath(cx, cy, r, arc.start, arc.end)}
            fill="none"
            stroke={arc.color}
            strokeWidth={strokeWidth}
            strokeLinecap="butt"
          >
            <title>{arc.label}: {arc.value.toLocaleString()}</title>
          </path>
        ))}
        {label && (
          <text
            x={cx}
            y={cy + 1}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, fill: "var(--ink-2)", fontWeight: 700 }}
          >
            {label}
          </text>
        )}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {arcs.map((arc) => (
          <div key={arc.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: arc.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-1)" }}>{arc.label}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginLeft: 4 }}>
              {((arc.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
