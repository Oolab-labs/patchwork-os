import { isHaltStatus } from "@/lib/runStatus";

/**
 * Map a decision trace's body status/outcome to a coarse display state.
 *
 * Lives in lib/ (not the traces page) because Next.js page modules may
 * only export the framework's allowed names — a stray named export on
 * page.tsx fails the generated `.next/types` constraint. Keeping it here
 * also makes it unit-testable in isolation.
 *
 * `interrupted` / `cancelled` are terminal halts: they must render as
 * "error", not the old "running" catch-all. `isHaltStatus` is the
 * canonical halt set (error/failed/cancelled/interrupted); `rejected` /
 * `errored` are kept explicitly since that set doesn't include them.
 */
export function traceStatus(t: {
  body?: { status?: unknown; outcome?: unknown } | null;
}): "done" | "error" | "running" {
  const s = String(t.body?.status ?? t.body?.outcome ?? "").toLowerCase();
  if (s === "ok" || s === "done" || s === "success" || s === "approved") return "done";
  if (isHaltStatus(s) || s === "rejected" || s === "errored") return "error";
  return "running";
}
