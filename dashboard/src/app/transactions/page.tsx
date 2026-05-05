"use client";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { ErrorState } from "@/components/patchwork";

interface TransactionEdit {
  filePath: string;
  sizeBefore: number;
  sizeAfter: number;
  lineDelta: number;
}

interface Transaction {
  id: string;
  createdAt: number;
  expiresAt: number;
  edits: TransactionEdit[];
}

interface TransactionsResponse {
  transactions: Transaction[];
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (Math.abs(sec) < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ms).toLocaleString();
}

function ttlRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

// Single shared 1Hz tick for every TTL pill on the page. The previous
// implementation set up one setInterval per TtlPill — fine at 3 rows,
// wasteful at 30. Now there's one tick on the module scope and pills
// subscribe via a tiny pub/sub.
type Subscriber = () => void;
const tickSubscribers = new Set<Subscriber>();
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
function subscribeTtlTick(fn: Subscriber): () => void {
  tickSubscribers.add(fn);
  if (tickIntervalId === null && typeof window !== "undefined") {
    tickIntervalId = setInterval(() => {
      for (const sub of tickSubscribers) sub();
    }, 1000);
  }
  return () => {
    tickSubscribers.delete(fn);
    if (tickSubscribers.size === 0 && tickIntervalId !== null) {
      clearInterval(tickIntervalId);
      tickIntervalId = null;
    }
  };
}

// Ticking TTL pill: amber > 1m, red 30s-1m, red+pulsing < 30s, expired = err.
function TtlPill({ expiresAt }: { expiresAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => subscribeTtlTick(() => setTick((t) => t + 1)), []);
  const ms = Math.max(0, expiresAt - Date.now());
  const expired = ms === 0;
  const critical = !expired && ms < 30_000;
  const warning = !expired && !critical && ms < 60_000;
  const cls =
    expired || critical
      ? "pill err"
      : warning
        ? "pill warn"
        : "pill muted";
  return (
    <span
      className={cls}
      title={`expires ${new Date(expiresAt).toISOString()}`}
      style={critical ? { animation: "pulse-dot 0.8s ease-in-out infinite", fontWeight: 700 } : undefined}
    >
      TTL {ttlRemaining(expiresAt)}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TransactionsPage() {
  const { data, error, loading } = useBridgeFetch<TransactionsResponse>(
    "/api/bridge/transactions",
    { intervalMs: 3000 },
  );
  const [busy, setBusy] = useState<Record<string, "rolling-back" | string>>({});
  const transactions = data?.transactions ?? [];

  async function rollback(id: string) {
    setBusy((p) => ({ ...p, [id]: "rolling-back" }));
    try {
      const res = await fetch(apiPath(`/api/bridge/transactions/${id}/rollback`), {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setBusy((p) => ({
        ...p,
        [id]: res.ok && body.ok !== false ? "discarded" : `error: ${body.error ?? res.status}`,
      }));
    } catch (e) {
      setBusy((p) => ({
        ...p,
        [id]: `error: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  // Clear stale busy entries for transactions that are no longer in the list,
  // so a reused id can't pre-disable a brand-new transaction's Discard button.
  useEffect(() => {
    const liveIds = new Set(transactions.map((t) => t.id));
    setBusy((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [id, val] of Object.entries(prev)) {
        if (liveIds.has(id)) {
          next[id] = val;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [transactions]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Transactions — <span className="accent">staged edits, awaiting your nod.</span>
          </h1>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Active staged multi-file edits — review, then commit from the agent
            (MCP <code>commitTransaction</code>) or discard from here. See{" "}
            <a
              href="https://github.com/Oolab-labs/patchwork-os/blob/HEAD/documents/speculative-refactoring.md"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              the speculative-refactoring doc
            </a>{" "}
            for the workflow.
          </div>
        </div>
        <div>
          <span className="pill muted">
            {transactions.length} active
          </span>
        </div>
      </div>

      {loading && transactions.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}
      {error && transactions.length === 0 && (
        <ErrorState
          title="Couldn't load transactions"
          description="The bridge isn't responding to /transactions. The next poll will try again automatically."
          error={error}
        />
      )}
      {error && transactions.length > 0 && (
        <div className="alert-err">Refresh failed — {error}</div>
      )}

      {!loading && transactions.length === 0 && (
        <div className="empty-state">
          <h3>No active transactions</h3>
          <p>
            When an agent calls <code>beginTransaction</code> + <code>stageEdit</code>,
            the staged edits appear here. Until <code>commitTransaction</code> fires,
            nothing has touched disk.
          </p>
        </div>
      )}

      {transactions.map((tx) => {
        const totalDelta = tx.edits.reduce((s, e) => s + e.lineDelta, 0);
        const state = busy[tx.id];
        return (
          <div
            key={tx.id}
            className="card"
            style={{ marginTop: "var(--s-4)" }}
          >
            <div className="card-head">
              <h2>
                <code style={{ fontSize: 14 }}>{tx.id}</code>
              </h2>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="pill muted" title={new Date(tx.createdAt).toISOString()}>
                  staged {relTime(tx.createdAt)}
                </span>
                <TtlPill expiresAt={tx.expiresAt} />
                <span className="pill muted">
                  {tx.edits.length} file{tx.edits.length === 1 ? "" : "s"}
                </span>
                <span
                  className={`pill ${totalDelta > 0 ? "ok" : totalDelta < 0 ? "err" : "muted"}`}
                >
                  {totalDelta > 0 ? "+" : ""}{totalDelta} lines
                </span>
              </div>
            </div>

            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th style={{ width: 120 }}>Before</th>
                    <th style={{ width: 120 }}>After</th>
                    <th style={{ width: 100 }}>Δ lines</th>
                  </tr>
                </thead>
                <tbody>
                  {tx.edits.map((e) => (
                    <tr key={e.filePath}>
                      <td className="mono">{e.filePath}</td>
                      <td className="mono muted">{formatBytes(e.sizeBefore)}</td>
                      <td className="mono">{formatBytes(e.sizeAfter)}</td>
                      <td
                        className="mono"
                        style={{
                          color:
                            e.lineDelta > 0
                              ? "var(--ok)"
                              : e.lineDelta < 0
                                ? "var(--err)"
                                : "var(--fg-2)",
                        }}
                      >
                        {e.lineDelta > 0 ? "+" : ""}{e.lineDelta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: 14,
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <button
                type="button"
                className="btn danger"
                disabled={state === "rolling-back" || state === "discarded"}
                onClick={() => void rollback(tx.id)}
              >
                {state === "rolling-back" ? "Discarding…" : "Discard"}
              </button>
              <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
                Commit happens from the agent — call{" "}
                <code>commitTransaction</code> with this ID. Discard is safe;
                nothing has touched disk.
              </span>
              {state && state !== "rolling-back" && (
                <span className="pill muted" style={{ marginLeft: "auto" }}>
                  {state}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
