"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export interface DetailPageHeaderBreadcrumb {
  label: string;
  href?: string;
}

interface DetailPageHeaderProps {
  breadcrumb?: DetailPageHeaderBreadcrumb[];
  title: ReactNode;
  statusBadge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  sticky?: boolean;
}

export function DetailPageHeader({
  breadcrumb,
  title,
  statusBadge,
  meta,
  actions,
  sticky = true,
}: DetailPageHeaderProps) {
  return (
    <div
      className="card"
      style={{
        ...(sticky ? { position: "sticky", top: 0, zIndex: 5 } : {}),
        padding: "14px 20px",
        marginBottom: "var(--s-4)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, justifyContent: "space-between" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {breadcrumb && breadcrumb.length > 0 && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 400,
                color: "var(--ink-3)",
                marginBottom: 4,
                display: "flex",
                alignItems: "center",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              {breadcrumb.map((crumb, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {i > 0 && <span style={{ color: "var(--ink-3)", opacity: 0.6 }}>›</span>}
                  {crumb.href ? (
                    <Link
                      href={crumb.href}
                      style={{ color: "var(--ink-3)", textDecoration: "none" }}
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                </span>
              ))}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--ink-1)", lineHeight: 1.2 }}>
              {title}
            </h1>
            {statusBadge && (
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                {statusBadge}
              </span>
            )}
          </div>

          {meta && (
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                fontWeight: 400,
                color: "var(--ink-2)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {meta}
            </div>
          )}
        </div>

        {actions && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
              flexWrap: "wrap",
            }}
          >
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
