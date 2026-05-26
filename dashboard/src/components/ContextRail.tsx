import type { ReactNode } from "react";

interface ContextRailProps {
  children: ReactNode;
  rail?: ReactNode;
}

export function ContextRail({ children, rail }: ContextRailProps) {
  if (!rail) return <>{children}</>;
  return (
    <div className="context-rail-layout">
      <div style={{ minWidth: 0 }}>{children}</div>
      <aside className="context-rail">{rail}</aside>
    </div>
  );
}

export function RailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="context-rail-section">
      <div className="context-rail-label">{label}</div>
      {children}
    </div>
  );
}
