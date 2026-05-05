import type { CSSProperties } from "react";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width, height, className = "", style }: SkeletonProps) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ display: "block", width, height, ...style }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({
  width = "100%",
  size,
}: { width?: string | number; size?: "sm" | "lg" }) {
  return (
    <Skeleton
      className={`skeleton-text${size ? ` ${size}` : ""}`}
      width={width}
    />
  );
}

export function SkeletonStatCard() {
  return (
    <div className="stat-card" aria-hidden="true">
      <SkeletonText width="55%" size="sm" />
      <div style={{ marginTop: 10 }}>
        <SkeletonText width="40%" size="lg" />
      </div>
      <div style={{ marginTop: 8 }}>
        <SkeletonText width="65%" size="sm" />
      </div>
    </div>
  );
}

export function SkeletonRow({ columns = 3 }: { columns?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 12,
        padding: "12px 14px",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      {Array.from({ length: columns }).map((_, i) => (
        <SkeletonText key={i} width={`${60 + ((i * 13) % 30)}%`} size="sm" />
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-hidden="true" style={{ padding: 16 }}>
      <SkeletonText width="40%" size="lg" />
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonText key={i} width={`${100 - i * 12}%`} size="sm" />
        ))}
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 4, columns = 3 }: { rows?: number; columns?: number }) {
  return (
    <div className="card" aria-hidden="true" style={{ padding: 0, overflow: "hidden" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </div>
  );
}
