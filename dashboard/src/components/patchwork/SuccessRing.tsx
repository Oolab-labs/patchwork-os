"use client";

/**
 * Small donut ring showing success rate (0-100). Promoted from
 * recipes/page.tsx so Overview's RecipeLeaderboard and other surfaces
 * can render per-recipe health without duplicating the SVG.
 */

export interface SuccessRingProps {
  pct: number | null;
  size?: number;
  stroke?: number;
}

export function SuccessRing({ pct, size = 28, stroke = 4 }: SuccessRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const safePct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (safePct / 100) * c;
  const color =
    pct == null
      ? "var(--line-3)"
      : safePct >= 90
        ? "var(--ok)"
        : safePct >= 60
          ? "var(--warn)"
          : "var(--err)";
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flexShrink: 0 }}
      aria-label={pct == null ? "no run data" : `${Math.round(safePct)}% success`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--line-3)"
        strokeWidth={stroke}
      />
      {pct != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: size <= 28 ? 8 : 10,
          fontWeight: 700,
          fill: "var(--ink-1)",
        }}
      >
        {pct == null ? "—" : `${Math.round(safePct)}%`}
      </text>
    </svg>
  );
}
