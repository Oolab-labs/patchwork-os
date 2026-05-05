"use client";

export interface AreaChartSeries {
  values: number[];
  color?: string;
  label?: string;
}

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
  const W = 400;
  const H = height;
  const PAD = { top: 8, right: 8, bottom: 20, left: 32 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const allVals = series.flatMap((s) => s.values);
  const maxVal = Math.max(...allVals, 1);
  const n = Math.max(...series.map((s) => s.values.length), 2);

  function toX(i: number) {
    return PAD.left + (i / (n - 1)) * chartW;
  }
  function toY(v: number) {
    return PAD.top + chartH - (v / maxVal) * chartH;
  }

  function buildPath(values: number[]): { line: string; area: string } {
    const pts = values.map((v, i) => [toX(i), toY(v)] as const);
    if (pts.length < 2) return { line: "", area: "" };
    const line = pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
    const area = `${line} L${pts[pts.length - 1][0]},${PAD.top + chartH} L${pts[0][0]},${PAD.top + chartH} Z`;
    return { line, area };
  }

  const tickVals = Array.from({ length: yTicks }, (_, i) =>
    Math.round((maxVal / (yTicks - 1)) * i),
  );

  const colors = ["var(--orange)", "var(--blue)", "var(--green)", "var(--red)"];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
      aria-hidden="true"
    >
      <defs>
        {series.map((s, si) => {
          const color = s.color ?? colors[si % colors.length];
          return (
            <linearGradient key={si} id={`acGrad${si}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          );
        })}
      </defs>

      {/* y-axis ticks */}
      {tickVals.map((v) => {
        const y = toY(v);
        return (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y}
              y2={y}
              stroke="var(--line-3)"
              strokeWidth={0.5}
            />
            <text
              x={PAD.left - 4}
              y={y + 1}
              textAnchor="end"
              dominantBaseline="middle"
              style={{ fontFamily: "var(--font-mono)", fontSize: 7, fill: "var(--ink-3)" }}
            >
              {v}
            </text>
          </g>
        );
      })}

      {/* x-axis labels */}
      {xLabels &&
        xLabels.map((lbl, i) => {
          if (i % Math.ceil(xLabels.length / 6) !== 0 && i !== xLabels.length - 1) return null;
          return (
            <text
              key={i}
              x={toX(i)}
              y={H - 4}
              textAnchor="middle"
              style={{ fontFamily: "var(--font-mono)", fontSize: 7, fill: "var(--ink-3)" }}
            >
              {lbl}
            </text>
          );
        })}

      {/* series */}
      {series.map((s, si) => {
        const color = s.color ?? colors[si % colors.length];
        const { line, area } = buildPath(s.values);
        if (!line) return null;
        return (
          <g key={si}>
            <path d={area} fill={`url(#acGrad${si})`} />
            <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}
