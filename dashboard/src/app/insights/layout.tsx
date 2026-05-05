import type { ReactNode } from "react";
import { AnalyticsTabs } from "@/components/AnalyticsTabs";

export const metadata = {
  title: "Insights — Patchwork OS",
};

export default function InsightsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AnalyticsTabs />
      {children}
    </>
  );
}
