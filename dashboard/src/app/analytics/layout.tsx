import type { ReactNode } from "react";
import { AnalyticsTabs } from "@/components/AnalyticsTabs";
export const metadata = { title: "Analytics — Patchwork OS" };
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <AnalyticsTabs />
      {children}
    </>
  );
}
