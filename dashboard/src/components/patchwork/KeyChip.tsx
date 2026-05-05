import type { ReactNode } from "react";

export function KeyChip({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
