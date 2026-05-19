"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useRecipeRunStream, type ActiveRunState } from "./useRecipeRunStream";

/**
 * Shell-level provider that holds ONE SSE subscription to the bridge's
 * lifecycle stream and exposes the live "what's running right now" map
 * to every page. Before this, each page that wanted the data opened its
 * own EventSource — /recipes opened one, /runs opened another, and any
 * page that wanted a sidebar badge would have opened a third.
 *
 * Mount once in `Shell.tsx`; consumers call `useActiveRuns()`,
 * `useRecipeRun(name)`, or `useActiveRunCount()`. The selector hooks
 * memoize so a row consumer only sees a re-render when ITS recipe
 * changes, not on every step event.
 */

interface LiveRunsValue {
  active: Map<string, ActiveRunState>;
  connected: boolean;
}

const LiveRunsContext = createContext<LiveRunsValue | null>(null);

export function LiveRunsProvider({ children }: { children: ReactNode }) {
  const { active, connected } = useRecipeRunStream();
  const value = useMemo(() => ({ active, connected }), [active, connected]);
  return <LiveRunsContext.Provider value={value}>{children}</LiveRunsContext.Provider>;
}

function useLiveRunsValue(): LiveRunsValue {
  const v = useContext(LiveRunsContext);
  // When a consumer renders outside the provider (e.g. tests, storybook),
  // return an empty Map rather than throwing — graceful no-op.
  return v ?? EMPTY_VALUE;
}
const EMPTY_VALUE: LiveRunsValue = { active: new Map(), connected: false };

/** Full live-runs Map keyed by recipeName. */
export function useActiveRuns(): Map<string, ActiveRunState> {
  return useLiveRunsValue().active;
}

/** Lookup a single recipe's live state; undefined if none. */
export function useRecipeRun(name: string | undefined): ActiveRunState | undefined {
  const { active } = useLiveRunsValue();
  if (!name) return undefined;
  return active.get(name);
}

/** Count of currently-running (status === "running") recipes. */
export function useActiveRunCount(): number {
  const { active } = useLiveRunsValue();
  let n = 0;
  for (const v of active.values()) if (v.status === "running") n++;
  return n;
}

/** Bridge-stream connection state (boolean). */
export function useLiveRunsConnected(): boolean {
  return useLiveRunsValue().connected;
}
