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
