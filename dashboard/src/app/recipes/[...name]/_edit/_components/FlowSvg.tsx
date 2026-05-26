"use client";

import { useId } from "react";
import { computeFlowLayout, NODE_W, NODE_H } from "./flowLayout";

export type StepStatus =
  | "ok"
  | "done"
  | "success"
  | "error"
  | "failed"
  | "halted"
  | "running"
  | "pending"
  | "skipped";

export interface FlowSvgStep {
  id: string;
  type: "tool" | "agent" | "recipe";
  tool?: string;
  namespace?: string;
  prompt?: string;
  dependencies?: string[];
  recipe?: string;
}

interface FlowSvgProps {
  steps: FlowSvgStep[];
  stepStatuses?: Record<string, StepStatus>;
  onStepClick?: (id: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

const STATUS_FILL: Record<string, string> = {
  ok: "color-mix(in srgb, var(--ok) 20%, var(--bg-1))",
  done: "color-mix(in srgb, var(--ok) 20%, var(--bg-1))",
  success: "color-mix(in srgb, var(--ok) 20%, var(--bg-1))",
  error: "color-mix(in srgb, var(--err) 25%, var(--bg-1))",
  failed: "color-mix(in srgb, var(--err) 25%, var(--bg-1))",
  halted: "color-mix(in srgb, var(--warn) 20%, var(--bg-1))",
  running: "color-mix(in srgb, var(--accent-cool) 20%, var(--bg-1))",
  pending: "var(--bg-1)",
  skipped: "var(--bg-2)",
};

const STATUS_STROKE: Record<string, string> = {
  ok: "var(--ok)",
  done: "var(--ok)",
  success: "var(--ok)",
  error: "var(--err)",
  failed: "var(--err)",
  halted: "var(--warn)",
  running: "var(--accent-cool)",
  pending: "var(--line-2)",
  skipped: "var(--ink-3)",
};

const STATUS_GLYPH: Record<string, string> = {
  ok: "✓",
  done: "✓",
  success: "✓",
  error: "!",
  failed: "!",
  halted: "!",
  running: "◍",
  pending: "⋯",
  skipped: "−",
};

function stepLabel(step: FlowSvgStep): { title: string; subtitle: string } {
  if (step.tool)
    return { title: step.tool, subtitle: step.namespace ?? step.type };
  if (step.recipe) return { title: step.recipe, subtitle: "recipe" };
  if (step.prompt) {
    const t =
      step.prompt.length > 26 ? step.prompt.slice(0, 25) + "…" : step.prompt;
    return { title: t, subtitle: "agent" };
  }
  return { title: step.id, subtitle: step.type };
}

function stepInitials(step: FlowSvgStep): string {
  const { title } = stepLabel(step);
  return title.slice(0, 2).toUpperCase();
}

function StepNode({
  step,
  x,
  y,
  status,
  onClick,
}: {
  step: FlowSvgStep;
  x: number;
  y: number;
  status?: string;
  onClick?: () => void;
}) {
  const { title, subtitle } = stepLabel(step);
  const displayTitle = title.length > 20 ? title.slice(0, 19) + "…" : title;
  const badgeFill = status ? (STATUS_FILL[status] ?? "var(--bg-1)") : undefined;
  const badgeStroke = status
    ? (STATUS_STROKE[status] ?? "var(--line-2)")
    : undefined;
  const glyph = status ? (STATUS_GLYPH[status] ?? "") : undefined;
  const isRunning = status === "running";

  return (
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: onClick ? "pointer" : "default" }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`Step: ${title}`}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {/* Node body */}
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill="var(--bg-1)"
        stroke="var(--line-2)"
        strokeWidth={1}
      />
      {/* Icon container */}
      <rect x={8} y={8} width={40} height={40} rx={8} fill="var(--bg-2)" />
      {/* Icon initials */}
      <text
        x={28}
        y={33}
        textAnchor="middle"
        fontSize={12}
        fontWeight={700}
        fontFamily="var(--font-mono)"
        fill="var(--ink-3)"
        style={{ userSelect: "none" }}
      >
        {stepInitials(step)}
      </text>
      {/* Title */}
      <text
        x={56}
        y={24}
        fontSize={13}
        fontWeight={700}
        fill="var(--ink-1)"
        style={{ userSelect: "none" }}
      >
        <title>{title}</title>
        {displayTitle}
      </text>
      {/* Subtitle */}
      <text
        x={56}
        y={40}
        fontSize={11}
        fontWeight={400}
        fill="var(--ink-3)"
        style={{ userSelect: "none" }}
      >
        {subtitle}
      </text>

      {/* Port: input (left) */}
      <circle
        cx={0}
        cy={NODE_H / 2}
        r={5}
        fill="var(--bg-0)"
        stroke="var(--line-1)"
        strokeWidth={1.5}
      />
      {/* Port: output (right) */}
      <circle
        cx={NODE_W}
        cy={NODE_H / 2}
        r={5}
        fill="var(--bg-0)"
        stroke="var(--line-1)"
        strokeWidth={1.5}
      />

      {/* Status badge */}
      {status && (
        <g transform={`translate(${NODE_W + 2},-14)`}>
          {isRunning && (
            <circle
              cx={14}
              cy={14}
              r={14}
              fill="none"
              stroke={badgeStroke}
              strokeWidth={2}
              strokeDasharray="10 6"
              opacity={0.5}
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 14 14"
                to="360 14 14"
                dur="1.2s"
                repeatCount="indefinite"
              />
            </circle>
          )}
          <circle
            cx={14}
            cy={14}
            r={12}
            fill={badgeFill}
            stroke={badgeStroke}
            strokeWidth={2}
          />
          <text
            x={14}
            y={19}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill={badgeStroke}
            style={{ userSelect: "none" }}
          >
            {glyph}
          </text>
        </g>
      )}
    </g>
  );
}

export function FlowSvg({
  steps,
  stepStatuses,
  onStepClick,
  className,
  style,
}: FlowSvgProps) {
  const patternId = useId().replace(/:/g, "");

  if (steps.length === 0) return null;

  const layout = computeFlowLayout(steps);
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const stepById = new Map(steps.map((s) => [s.id, s]));

  // Extra right padding for status badge overflow
  const svgW = layout.width + 36;
  const svgH = layout.height;

  return (
    <svg
      className={className}
      style={{ maxWidth: "100%", display: "block", ...style }}
      viewBox={`0 0 ${svgW} ${svgH}`}
      width={svgW}
      height={svgH}
      aria-label="Recipe step flow diagram"
      role="img"
    >
      <defs>
        <pattern
          id={patternId}
          x="0"
          y="0"
          width="18"
          height="18"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="0.5" cy="0.5" r="0.5" fill="var(--line-2)" />
        </pattern>
      </defs>

      {/* Canvas */}
      <rect width={svgW} height={svgH} fill="var(--bg-0)" />
      <rect width={svgW} height={svgH} fill={`url(#${patternId})`} />

      {/* Edges — cubic Bezier, horizontal control handles */}
      {layout.edges.map(({ fromId, toId }) => {
        const from = nodeById.get(fromId);
        const to = nodeById.get(toId);
        if (!from || !to) return null;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const cx = (x1 + x2) / 2;
        return (
          <path
            key={`${fromId}→${toId}`}
            d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke="var(--line-1)"
            strokeWidth={1.5}
          />
        );
      })}

      {/* Nodes */}
      {layout.nodes.map(({ id, x, y }) => {
        const step = stepById.get(id);
        if (!step) return null;
        return (
          <StepNode
            key={id}
            step={step}
            x={x}
            y={y}
            status={stepStatuses?.[id]}
            onClick={
              onStepClick
                ? () => onStepClick(id)
                : undefined
            }
          />
        );
      })}
    </svg>
  );
}
