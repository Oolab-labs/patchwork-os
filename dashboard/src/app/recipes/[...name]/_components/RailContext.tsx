"use client";

/**
 * Bridges the Overview page's state (recipe, run/toggle handlers, status)
 * up to the shared rail rendered by `layout.tsx`. The rail sits in the
 * layout, one level above `page.tsx` in the tree, so it can't read
 * page-local state directly — the Overview page publishes what the rail
 * needs to show/act on via `RailProvider`; the rail reads it via
 * `useRailData()`. Edit/Plan routes never publish, so `useRailData()`
 * there returns `null` and the rail falls back to its own
 * independently-fetched summary (name/status/enabled) with no action
 * buttons — matches those routes already skipping the two-column grid.
 */

import { createContext, useContext } from "react";
import type { NeedFix } from "@/lib/recipeStatus";
import type { MedallionTone } from "@/components/StatusMedallion";

export interface RailNeedRow {
  key: string;
  sentence: string;
  fix?: { action: NeedFix; label: string };
}

export interface RailData {
  /** True once the recipe list has resolved and this recipe was found. */
  ready: boolean;
  enabled: boolean;
  trigger: string;
  scheduleText: string;
  lastRunLabel: string;
  lastRunTone?: "ok" | "warn" | "err" | "info" | "muted";
  lastRunWhen?: string;
  successPct: number | null;
  avgDuration: string;
  connectors: Array<{ id: string; healthy?: boolean }>;
  medallionTone: MedallionTone;
  needs: RailNeedRow[];
  runDisabled: boolean;
  toggling: boolean;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onResumeFix: () => void;
}

const RailContext = createContext<RailData | null>(null);

export function RailProvider({
  value,
  children,
}: {
  value: RailData;
  children: React.ReactNode;
}) {
  return <RailContext.Provider value={value}>{children}</RailContext.Provider>;
}

/** Returns null on routes that never publish (Edit/Plan, or before mount). */
export function useRailData(): RailData | null {
  return useContext(RailContext);
}
