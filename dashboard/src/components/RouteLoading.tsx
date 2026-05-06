import { SkeletonList } from "./Skeleton";

// Shared route-level loading body. Used by per-route loading.tsx files so
// navigation always shows progress instead of a blank flash.
export function RouteLoading({ rows = 6, columns = 3 }: { rows?: number; columns?: number }) {
  return (
    <section style={{ padding: "1.25rem 0" }} aria-busy="true" aria-live="polite">
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div style={{ height: 28, width: "32%", background: "var(--bg-2)", borderRadius: 6 }} />
      </div>
      <SkeletonList rows={rows} columns={columns} />
    </section>
  );
}
