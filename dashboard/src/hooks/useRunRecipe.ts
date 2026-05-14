"use client";

import { useCallback, useState } from "react";
import { apiPath } from "@/lib/api";
import { useToast } from "@/components/Toast";

interface RunResponse {
  ok: boolean;
  taskId?: string;
  error?: string;
}

/**
 * Fire-and-toast hook for one-click recipe runs from the dashboard.
 * The /recipes page has its own inline run flow with var-prompts; this
 * hook is the lightweight, no-vars equivalent for landing-page quick
 * wins ("Re-run that halted run", "Run the featured recipe").
 *
 * Returns a stable callback + a per-recipe pending map keyed by name
 * so call sites can disable a button while its run is in flight.
 */
export function useRunRecipe() {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, true>>({});

  const run = useCallback(
    async (name: string): Promise<RunResponse> => {
      setPending((p) => ({ ...p, [name]: true }));
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}/run`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        const data = (await res.json().catch(() => ({}))) as RunResponse;
        if (data.ok && data.taskId) {
          toast.success(`${name} queued · ${data.taskId.slice(0, 8)}`, {
            duration: 4000,
          });
          return data;
        }
        if (data.error === "already_in_flight") {
          toast.warn(`${name} is already running.`);
        } else {
          toast.error(`Couldn't run ${name}: ${data.error ?? `HTTP ${res.status}`}`);
        }
        return data;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Couldn't run ${name}: ${msg}`);
        return { ok: false, error: msg };
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[name];
          return next;
        });
      }
    },
    [toast],
  );

  return { run, pending };
}
