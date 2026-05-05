import type { ReactNode } from "react";

export function SectionHeader({
  title,
  eyebrow,
  action,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        {eyebrow && <div className="section-eyebrow">{eyebrow}</div>}
        <div className="section-title">{title}</div>
      </div>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}
