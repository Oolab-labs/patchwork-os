"use client";

import { useCallback, useState } from "react";
import { apiPath } from "@/lib/api";
import { useToast } from "@/components/Toast";

interface ToggleableRecipe {
  name: string;
  enabled?: boolean;
  trigger?: string;
}

interface ToggleOpts {
  /** Called right after the confirm gate passes, before the PATCH fires —
   *  callers with local recipe-list state use this for an optimistic flip. */
  onOptimistic?: (nextEnabled: boolean) => void;
  onSuccess?: () => void;
  /** Called if the PATCH fails, so an optimistic flip can be rolled back. */
  onRollback?: (previousEnabled: boolean) => void;
}

interface ToggleResult {
  ok: boolean;
  cancelled?: boolean;
}

/**
 * Shared pause/enable-a-recipe action, extracted from `recipes/page.tsx`'s
 * `handleToggleEnabled` so every call site — the recipes page AND the
 * Overview deck's copilot pane — goes through the identical safety gate:
 * disabling a non-manual trigger (cron/webhook/event) confirms first via
 * `window.confirm`, since it silently stops a recurring job. A caller
 * that instead PATCHes `/api/bridge/recipes/{name}` directly bypasses
 * this confirm entirely — the exact naive-wiring mistake flagged in
 * docs/plans/dashboard-terminal-copilot-plan-2026-07-03.md's risk
 * register. Always call this hook's `toggle`, never the raw endpoint.
 */
export function useToggleRecipeEnabled() {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, true>>({});

  const toggle = useCallback(
    async (recipe: ToggleableRecipe, opts?: ToggleOpts): Promise<ToggleResult> => {
      const target = recipe.enabled === false;
      const trigger = recipe.trigger ?? "manual";
      const isAutonomous = trigger !== "manual";
      if (!target && isAutonomous) {
        const proceed = window.confirm(
          `Disable "${recipe.name}"? Trigger "${trigger}" will stop firing until you re-enable.`,
        );
        if (!proceed) return { ok: false, cancelled: true };
      }

      setPending((p) => ({ ...p, [recipe.name]: true }));
      opts?.onOptimistic?.(target);
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(recipe.name)}`),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: target }),
          },
        );
        if (!res.ok) throw new Error(`/recipes/${recipe.name} ${res.status}`);
        opts?.onSuccess?.();
        toast.success(`${recipe.name} ${target ? "enabled" : "disabled"}`);
        return { ok: true };
      } catch (e) {
        opts?.onRollback?.(!target);
        toast.error(
          `Couldn't ${target ? "enable" : "disable"} ${recipe.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return { ok: false };
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[recipe.name];
          return next;
        });
      }
    },
    [toast],
  );

  return { toggle, pending };
}
