"use client";
interface RunSparkBarsProps {
  runs: { status: string }[];
  width?: number;
  height?: number;
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === "done" || s === "success") return "var(--ok)";
  if (s === "error" || s === "failed" || s === "errored") return "var(--err)";
  if (s === "running") return "var(--warn)";
  return "var(--ink-3, #9ca3af)";
}

export function RunSparkBars({ runs, width = 56, height = 18 }: RunSparkBarsProps) {
  const slots = Array.from({ length: 5 }, (_, i) => runs[i] ?? null);
  const barW = 6;
  const gap = 4;
  const totalW = 5 * barW + 4 * gap; // 46
  const offsetX = (width - totalW) / 2;

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", flexShrink: 0 }}
    >
      {slots.map((run, i) => (
        <rect
          key={i}
          x={offsetX + i * (barW + gap)}
          y={0}
          width={barW}
          height={height}
          rx={2}
          fill={run ? statusColor(run.status) : "var(--line-3, #e5e7eb)"}
          opacity={run ? 1 : 0.5}
        />
      ))}
    </svg>
  );
}
