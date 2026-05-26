import type { CSSProperties } from "react";

export type StatusKind = "ok" | "warn" | "err" | "running" | "paused" | "draft";

interface StatusRingProps {
  kind: StatusKind;
  label?: string;
  count?: number;
  size?: number;
  style?: CSSProperties;
}

const TOKEN: Record<StatusKind, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  running: "var(--accent-cool, #0787ff)",
  paused: "var(--ink-2)",
  draft: "var(--ink-3)",
};

function Glyph({ kind }: { kind: StatusKind }) {
  switch (kind) {
    case "ok":
      return <path d="M5 8l2.5 2.5L11 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />;
    case "err":
      return <text x="8" y="11.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">!</text>;
    case "warn":
      return <text x="8" y="11.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="currentColor">!</text>;
    case "running":
      return <circle cx="8" cy="8" r="2.5" fill="currentColor" />;
    case "paused":
      return (
        <>
          <rect x="5.5" y="5.5" width="2" height="5" rx="0.5" fill="currentColor" />
          <rect x="8.5" y="5.5" width="2" height="5" rx="0.5" fill="currentColor" />
        </>
      );
    case "draft":
      return null;
  }
}

export function StatusRing({ kind, label, count, size = 16, style }: StatusRingProps) {
  const color = TOKEN[kind];
  const r = (size / 2) - 2;
  const cx = size / 2;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        fill="none"
        aria-hidden="true"
        style={{ flexShrink: 0, color }}
      >
        <circle
          cx={cx}
          cy={cx}
          r={r}
          stroke="currentColor"
          strokeWidth="1.75"
          fill="none"
          opacity={kind === "draft" ? 0.5 : 1}
        />
        <Glyph kind={kind} />
      </svg>
      {(label !== undefined || count !== undefined) && (
        <span style={{ fontSize: "var(--fs-s)", fontWeight: 500, color: "var(--ink-2)", lineHeight: 1 }}>
          {label}
          {label && count !== undefined && " "}
          {count !== undefined && (
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--ink-1)" }}>{count}</span>
          )}
        </span>
      )}
    </span>
  );
}
