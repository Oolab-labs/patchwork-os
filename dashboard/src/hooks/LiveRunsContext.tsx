"use client";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { subscribeStreamLiveness, subscribeStreamMessage } from "@/lib/streamLiveness";
import type { ActiveRunState } from "./useRecipeRunStream";

/**
 * Shell-level live-runs store backed by a vanilla pub-sub + a single
 * shared SSE subscription. Selectors use `useSyncExternalStore` with
 * per-key subscriptions, so a row consumer only re-renders when ITS
 * recipe's slice changes — not on every step event from every recipe.
 *
 * The previous shape (useState<Map> behind a Context value) emitted a
 * fresh Map identity on every event, which made every page mounted
 * under Shell re-render unconditionally.
 */

const FINAL_HOLD_MS = 30_000;

interface LifecycleEvent {
  event?: string;
  metadata?: {
    runSeq?: number;
    recipeName?: string;
    stepId?: string;
    tool?: string;
    status?: "ok" | "error" | "skipped";
    error?: string;
    durationMs?: number;
    totalSteps?: number;
    haltReason?: string;
    haltCategory?: string;
  };
  ts?: number;
}

type Listener = () => void;

function createStore() {
  let active = new Map<string, ActiveRunState>();
  let connected = false;
  const allListeners = new Set<Listener>();
  const rowListeners = new Map<string, Set<Listener>>();
  const connectedListeners = new Set<Listener>();
  const gcTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function notifyRow(name: string) {
    const set = rowListeners.get(name);
    if (set) for (const cb of set) cb();
  }
  function notifyAll() {
    for (const cb of allListeners) cb();
  }

  function setRow(name: string, next: ActiveRunState | undefined) {
    const fresh = new Map(active);
    if (next) fresh.set(name, next);
    else fresh.delete(name);
    active = fresh;
    notifyRow(name);
    notifyAll();
  }

  return {
    applyEvent(type: string, raw: unknown) {
      if (type !== "lifecycle") return;
      const data = raw as LifecycleEvent | undefined;
      const md = data?.metadata;
      if (!data?.event || !md) return;
      const name = md.recipeName;
      if (!name) return;

      if (data.event === "recipe_started") {
        setRow(name, {
          runSeq: md.runSeq ?? 0,
          recipeName: name,
          totalSteps: md.totalSteps ?? 0,
          doneSteps: 0,
          startedAt: data.ts ?? Date.now(),
          status: "running",
        });
        const t = gcTimers.get(name);
        if (t) {
          clearTimeout(t);
          gcTimers.delete(name);
        }
      } else if (data.event === "recipe_step_start") {
        const cur = active.get(name);
        if (!cur) return;
        setRow(name, { ...cur, currentStepId: md.stepId, currentTool: md.tool });
      } else if (data.event === "recipe_step_done") {
        const cur = active.get(name);
        if (!cur) return;
        setRow(name, {
          ...cur,
          doneSteps: cur.doneSteps + 1,
          lastError: md.status === "error" ? md.error : cur.lastError,
        });
      } else if (data.event === "recipe_done") {
        const cur = active.get(name);
        if (!cur) return;
        const status: ActiveRunState["status"] = md.haltReason
          ? "halted"
          : md.status === "error"
            ? "error"
            : "ok";
        setRow(name, {
          ...cur,
          endedAt: data.ts ?? Date.now(),
          status,
          haltReason: md.haltReason,
          haltCategory: md.haltCategory,
        });
        const t = gcTimers.get(name);
        if (t) clearTimeout(t);
        const timer = setTimeout(() => {
          if (active.has(name)) setRow(name, undefined);
          gcTimers.delete(name);
        }, FINAL_HOLD_MS);
        gcTimers.set(name, timer);
      }
    },
    setConnected(next: boolean) {
      if (connected === next) return;
      connected = next;
      for (const cb of connectedListeners) cb();
    },
    getAll: () => active,
    getRow: (name: string | undefined) => (name ? active.get(name) : undefined),
    getConnected: () => connected,
    getActiveCount: () => {
      let n = 0;
      for (const v of active.values()) if (v.status === "running") n++;
      return n;
    },
    subscribeAll(cb: Listener) {
      allListeners.add(cb);
      return () => {
        allListeners.delete(cb);
      };
    },
    subscribeRow(name: string, cb: Listener) {
      let set = rowListeners.get(name);
      if (!set) {
        set = new Set();
        rowListeners.set(name, set);
      }
      set.add(cb);
      return () => {
        const cur = rowListeners.get(name);
        if (!cur) return;
        cur.delete(cb);
        if (cur.size === 0) rowListeners.delete(name);
      };
    },
    subscribeConnected(cb: Listener) {
      connectedListeners.add(cb);
      return () => {
        connectedListeners.delete(cb);
      };
    },
    clearGcTimers() {
      for (const t of gcTimers.values()) clearTimeout(t);
      gcTimers.clear();
    },
  };
}

// Module-singleton. One store per browser tab; safe because the
// provider mounts once at Shell.
const store = createStore();

const EMPTY_MAP: Map<string, ActiveRunState> = new Map();
const subscribeEmpty = () => () => {};

function isBrowser() {
  return typeof window !== "undefined";
}

export function LiveRunsProvider({ children }: { children: ReactNode }) {
  // Subscribe to the shared singleton SSE stream rather than opening
  // a second EventSource. Both subscriptions are idempotent; the
  // stream opens lazily on first subscriber and tears down when the
  // last unsubscribes.
  useEffect(() => {
    const unMsg = subscribeStreamMessage((type, data) => {
      store.applyEvent(type, data);
    });
    const unLive = subscribeStreamLiveness((live) => {
      store.setConnected(live);
    });
    return () => {
      unMsg();
      unLive();
      store.clearGcTimers();
    };
  }, []);

  return <>{children}</>;
}

/** Full live-runs Map keyed by recipeName. */
export function useActiveRuns(): Map<string, ActiveRunState> {
  return useSyncExternalStore(
    isBrowser() ? store.subscribeAll : subscribeEmpty,
    store.getAll,
    () => EMPTY_MAP,
  );
}

/**
 * Per-recipe selector — only fires when THIS recipe's slice changes.
 * `name` may be undefined for callers behind conditional data.
 */
export function useRecipeRun(name: string | undefined): ActiveRunState | undefined {
  const subscribe =
    name && isBrowser() ? (cb: Listener) => store.subscribeRow(name, cb) : subscribeEmpty;
  const getSnapshot = () => store.getRow(name);
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** Count of currently-running (status === "running") recipes. */
export function useActiveRunCount(): number {
  return useSyncExternalStore(
    isBrowser() ? store.subscribeAll : subscribeEmpty,
    store.getActiveCount,
    () => 0,
  );
}

/** Bridge-stream connection state (boolean). */
export function useLiveRunsConnected(): boolean {
  return useSyncExternalStore(
    isBrowser() ? store.subscribeConnected : subscribeEmpty,
    store.getConnected,
    () => false,
  );
}
