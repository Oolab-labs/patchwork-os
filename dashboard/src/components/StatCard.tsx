import Link from "next/link";
import type React from "react";

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  foot?: React.ReactNode;
  href?: string;
  className?: string;
}

export function StatCard({
  label,
  value,
  foot,
  href,
  className,
}: StatCardProps) {
  const cls = `stat-card${className ? ` ${className}` : ""}`;
  const inner = (
    <>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value">{value}</div>
      {foot != null && <div className="stat-card-foot">{foot}</div>}
    </>
  );

  if (href) {
    return (
      <Link className={cls} href={href}>
        {inner}
      </Link>
    );
  }

  return <div className={cls}>{inner}</div>;
}
