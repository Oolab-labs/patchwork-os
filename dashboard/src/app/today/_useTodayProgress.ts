"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * "Done" state for the 3-section progress strip, persisted in localStorage
 * keyed by today's local date — so it resets automatically at midnight
 * without any backend change. §3 ("glance at the team") has no automatic
 * completion signal (team-glancing is inherently manual), so it's the only
 * section driven purely by this hook; §1/§2 layer their own derived
 * "done" state (brief read / decisions cleared) on top and call `markDone`
 * only to persist that derived signal across a reload.
 */

const STORAGE_PREFIX = "patchwork.today.done.";

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${STORAGE_PREFIX}${y}-${m}-${d}`;
}

export type TodaySection = "brief" | "decisions" | "team";

interface DoneState {
  brief: boolean;
  decisions: boolean;
  team: boolean;
}

const EMPTY: DoneState = { brief: false, decisions: false, team: false };

function readStored(): DoneState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(todayKey());
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<DoneState>;
    return {
      brief: Boolean(parsed.brief),
      decisions: Boolean(parsed.decisions),
      team: Boolean(parsed.team),
    };
  } catch {
    return EMPTY;
  }
}

function writeStored(next: DoneState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(todayKey(), JSON.stringify(next));
  } catch {
    /* private mode — in-memory state still works for this tab */
  }
}

export function useTodayProgress(): {
  done: DoneState;
  markDone: (section: TodaySection, isDone?: boolean) => void;
} {
  const [done, setDone] = useState<DoneState>(EMPTY);

  // Read from localStorage after mount only (SSR has no window; avoids a
  // hydration mismatch between server-rendered EMPTY and client state).
  useEffect(() => {
    setDone(readStored());
  }, []);

  const markDone = useCallback((section: TodaySection, isDone = true) => {
    setDone((prev) => {
      if (prev[section] === isDone) return prev;
      const next = { ...prev, [section]: isDone };
      writeStored(next);
      return next;
    });
  }, []);

  return { done, markDone };
}
