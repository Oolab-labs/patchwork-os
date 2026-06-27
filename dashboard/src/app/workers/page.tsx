"use client";
import { EmptyState, ErrorState, HBarList } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface BoardRow {
  classKey: string;
  level: number;
  observations: number;
  mean: number;
}
interface Divergence {
  classKey: string;
  toolName: string;
  ramp: string;
  gate: string;
  at: number;
  note: string;
}
interface WorkerReport {
  workerId: string;
  name: string;
  autonomyCeiling: number;
  board: BoardRow[];
  compared: number;
  agreed: number;
  divergences: Divergence[];
}
interface ShadowResponse {
  workers: WorkerReport[];
  runsScanned: number;
  decisionsScanned: number;
  generatedAt?: string;
}

const LEVEL_LABELS = [
  "L0 suggest",
  "L1 approve-each",
  "L2 act+undo",
  "L3 act+sample",
  "L4 autonomous",
];

function levelColor(effective: number): string {
  if (effective >= 4) return "var(--ok)";
  if (effective >= 2) return "var(--warn)";
  return "var(--line-3)";
}

export default function WorkersPage() {
  const { data, error, loading, refetch } = useBridgeFetch<ShadowResponse>(
    "/api/bridge/workers/shadow",
    { intervalMs: 30000 },
  );
  const workers = data?.workers ?? [];

  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            Workers — <span className="accent">trust dial (shadow).</span>
          </h1>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Earned autonomy per worker × action-class, replayed read-only from
            the run + gate logs. No live decision is changed.
          </div>
        </div>
        {data && (
          <span className="pill muted">
            {data.runsScanned} runs · {data.decisionsScanned} gate decisions
          </span>
        )}
      </div>

      {loading && workers.length === 0 && <SkeletonList rows={3} columns={2} />}

      {error && workers.length === 0 && (
        <ErrorState
          title="Couldn't load workers"
          description="The bridge isn't responding to /workers/shadow."
          error={error}
          onRetry={refetch}
        />
      )}

      {!loading && !error && workers.length === 0 && (
        <EmptyState
          title="No workers yet"
          description="Add *.worker.yaml to ~/.patchwork/workers (e.g. copy templates/workers/)."
        />
      )}

      {workers.map((w) => {
        const effectiveItems = w.board.map((b) => {
          const effective = Math.min(b.level, w.autonomyCeiling);
          const capped =
            b.level > w.autonomyCeiling ? ` (earned L${b.level}, capped)` : "";
          return {
            label: b.classKey,
            value: effective,
            color: levelColor(effective),
            sub: `${LEVEL_LABELS[effective] ?? `L${effective}`} · ${b.observations} obs · ${Math.round(b.mean * 100)}% mean${capped}`,
          };
        });
        return (
          <div className="card" key={w.workerId} style={{ marginTop: "var(--s-4)" }}>
            <div className="card-head">
              <strong>{w.name}</strong>
              <span className="pill muted">ceiling L{w.autonomyCeiling}</span>
            </div>
            {w.board.length === 0 ? (
              <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
                No attributed activity yet — the dial fills as this worker runs.
              </div>
            ) : (
              <HBarList items={effectiveItems} max={4} />
            )}
            {w.compared > 0 && (
              <div style={{ marginTop: "var(--s-3)" }}>
                <span className="pill muted">
                  ramp vs gate: {w.agreed}/{w.compared} agree
                </span>
                {w.divergences.slice(0, 5).map((d, i) => (
                  <div
                    className="suggestion-row"
                    key={`${w.workerId}-${d.toolName}-${i}`}
                  >
                    ⚠ {d.toolName} — {d.note}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
