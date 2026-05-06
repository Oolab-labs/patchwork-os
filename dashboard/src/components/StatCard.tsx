import Link from "next/link";
import type React from "react";
import { GlassCard } from "./GlassCard";

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** Optional +/- delta string e.g. "+12%" or "-3". Positive → green, negative → red. */
  delta?: string;
  /** Optional icon rendered in top-right corner */
  icon?: React.ReactNode;
  foot?: React.ReactNode;
  href?: string;
  className?: string;
  /** Native tooltip shown on hover. Newlines are preserved by browsers. */
  title?: string;
}

function DeltaBadge({ delta }: { delta: string }) {
  const isPositive = delta.startsWith("+");
  const isNegative = delta.startsWith("-");
  const color = isPositive
    ? "var(--ok)"
    : isNegative
      ? "var(--err)"
      : "var(--fg-2)";
  const arrow = isPositive ? "↑" : isNegative ? "↓" : "";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        fontSize: "var(--fs-xs)",
        fontWeight: 600,
        color,
        background: isPositive
          ? "var(--ok-soft)"
          : isNegative
            ? "var(--err-soft)"
            : "var(--bg-2)",
        borderRadius: "var(--r-full)",
        padding: "1px 6px",
        marginLeft: 6,
        verticalAlign: "middle",
        lineHeight: 1.6,
      }}
    >
      {arrow && <span aria-hidden="true">{arrow}</span>}
      {delta.replace(/^[+-]/, "")}
    </span>
  );
}

function CardInner({
  label,
  value,
  delta,
  icon,
  foot,
}: Omit<StatCardProps, "href" | "className">) {
  return (
    <>
      {/* top row: label + optional icon */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: "var(--s-3)",
        }}
      >
        <div className="stat-card-label">{label}</div>
        {icon && (
          <span
            aria-hidden="true"
            style={{ display: "inline-flex", flexShrink: 0 }}
          >
            {icon}
          </span>
        )}
      </div>

      {/* value + delta */}
      <div
        style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap" }}
      >
        <div className="stat-card-value">{value}</div>
        {delta && <DeltaBadge delta={delta} />}
      </div>

      {/* foot */}
      {foot != null && (
        <div className="stat-card-foot" style={{ marginTop: "var(--s-2)" }}>
          {foot}
        </div>
      )}

    </>
  );
}

export function StatCard({
  label,
  value,
  delta,
  icon,
  foot,
  href,
  className,
  title,
}: StatCardProps) {
  const inner = (
    <CardInner
      label={label}
      value={value}
      delta={delta}
      icon={icon}
      foot={foot}
    />
  );

  if (href) {
    return (
      <Link
        href={href}
        title={title}
        style={{ display: "block", textDecoration: "none", color: "inherit" }}
      >
        <GlassCard className={`stat-card ${className ?? ""}`.trim()}>
          {inner}
        </GlassCard>
      </Link>
    );
  }

  return (
    <GlassCard
      className={`stat-card ${className ?? ""}`.trim()}
      title={title}
    >
      {inner}
    </GlassCard>
  );
}
