"use client";

interface RunInfo {
  status: string;
  /** ms epoch. Optional — when absent, the tooltip drops the relative time. */
  startedAt?: number;
  /** Duration in ms. Optional — used in tooltip. */
  durationMs?: number;
  /** Optional seq / id; tooltip prefers `seq` when present. */
  seq?: number | string;
  /** Optional halt reason; surfaced in tooltip on err rows. */
  haltReason?: string;
}

interface RunSparkBarsProps {
  runs: RunInfo[];
  /** Number of slots to render. Defaults to 5. */
  slots?: number;
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

function fmtAgo(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return `${Math.max(1, Math.floor(dt / 1000))}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

function fmtDur(ms?: number): string | null {
  if (typeof ms !== "number") return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Build the SVG <title> for a bar. SVG <title> renders as the browser's
 * native tooltip on hover — no JS-driven popover, no positioning math,
 * no z-index dance. Trade-off: appearance is browser-controlled (small
 * delay, plain styling), but for a quick-glance "what was that run?"
 * that's the right ergonomics. The bars used to be aria-hidden and
 * convey only a colour band; now they're individually labelled and
 * keyboard-focusable.
 */
function barTooltip(run: RunInfo, index: number, slotCount: number): string {
  const lines: string[] = [];
  const label =
    run.seq != null ? `Run #${run.seq}` : `Run ${slotCount - index} ago`;
  lines.push(`${label} · ${run.status}`);
  if (run.startedAt) lines.push(fmtAgo(run.startedAt));
  const dur = fmtDur(run.durationMs);
  if (dur) lines.push(dur);
  if (run.haltReason) lines.push(`halt: ${run.haltReason}`);
  return lines.join(" · ");
}

export function RunSparkBars({
  runs,
  slots: slotCount = 5,
  width = 56,
  height = 18,
}: RunSparkBarsProps) {
  const slots = Array.from({ length: slotCount }, (_, i) => runs[i] ?? null);
  const barW = 6;
  const gap = 4;
  const totalW = slotCount * barW + (slotCount - 1) * gap;
  const offsetX = (width - totalW) / 2;

  return (
    <svg
      role="img"
      aria-label={`Last ${slotCount} runs`}
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
          fill={run ? statusColor(run.status) : "var(--line-2, #e5e7eb)"}
          opacity={run ? 1 : 0.22}
          style={{
            cursor: run ? "help" : "default",
            transition: "opacity 120ms ease, transform 120ms ease",
            transformOrigin: `${offsetX + i * (barW + gap) + barW / 2}px ${height / 2}px`,
          }}
          onMouseEnter={
            run
              ? (ev) => {
                  ev.currentTarget.style.opacity = "0.78";
                  ev.currentTarget.style.transform = "scaleX(1.4)";
                }
              : undefined
          }
          onMouseLeave={
            run
              ? (ev) => {
                  ev.currentTarget.style.opacity = "1";
                  ev.currentTarget.style.transform = "";
                }
              : undefined
          }
        >
          {run && <title>{barTooltip(run, i, slotCount)}</title>}
        </rect>
      ))}
    </svg>
  );
}
