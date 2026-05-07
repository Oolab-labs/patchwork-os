import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && (
        <div style={{ marginBottom: 12, display: "flex", justifyContent: "center", color: "var(--ink-3)" }}>
          {icon}
        </div>
      )}
      <h3>{title}</h3>
      {description && (
        <p style={{ color: "var(--ink-2)", fontSize: "var(--fs-m)", maxWidth: 420, margin: "0 auto 16px" }}>
          {description}
        </p>
      )}
      {action && <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>{action}</div>}
    </div>
  );
}
