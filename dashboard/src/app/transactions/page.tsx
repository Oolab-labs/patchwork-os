"use client";
import { useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { EmptyState, ErrorState, HintCard, RelationStrip } from "@/components/patchwork";

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
  const { data, error, loading, refetch } = useBridgeFetch<TransactionsResponse>(
    "/api/bridge/transactions",
    { intervalMs: 3000 },
  );
  const [busy, setBusy] = useState<Record<string, "rolling-back" | string>>({});
  const [confirmingExpired, setConfirmingExpired] = useState(false);
  const transactions = data?.transactions ?? [];
  const toast = useToast();

  async function rollback(id: string) {
    setBusy((p) => ({ ...p, [id]: "rolling-back" }));
    try {
      const res = await fetch(apiPath(`/api/bridge/transactions/${id}/rollback`), {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok !== false) {
        setBusy((p) => ({ ...p, [id]: "discarded" }));
        toast.success("Transaction discarded");
        refetch();
      } else {
        const errMsg = body.error ?? String(res.status);
        setBusy((p) => ({ ...p, [id]: `error: ${errMsg}` }));
        toast.error(`Discard failed: ${errMsg}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBusy((p) => ({ ...p, [id]: `error: ${msg}` }));
      toast.error(`Discard failed: ${msg}`);
    }
  }

  const expiredIds = useMemo(
    () => transactions.filter((t) => t.expiresAt <= Date.now()).map((t) => t.id),
    // re-evaluate each tick — the page already polls every 3s + ticks the
    // TtlPill via a module-scope timer, so we don't need our own clock
    // dep here.
    [transactions],
  );

  useEffect(() => {
    if (expiredIds.length === 0) setConfirmingExpired(false);
  }, [expiredIds.length]);

  async function discardAllExpired() {
    if (expiredIds.length === 0) return;
    if (!confirmingExpired) {
      setConfirmingExpired(true);
      return;
    }
    setConfirmingExpired(false);
    // Serial to keep rate-limiting predictable and to make the UI state
    // changes visible row-by-row rather than as one giant flicker.
    for (const id of expiredIds) {
      // eslint-disable-next-line no-await-in-loop
      await rollback(id);
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 className="editorial-h1" style={{ margin: 0 }}>
              Transactions — <span className="accent">staged edits, awaiting your nod.</span>
            </h1>
            <HintCard.Toggle id="transactions" />
          </div>
          <div className="editorial-sub" style={{ fontFamily: "inherit" }}>
            Active staged multi-file edits — review, then commit from the agent
            (MCP <code>commitTransaction</code>) or discard from here. See{" "}
            <a
              href="https://github.com/Oolab-labs/patchwork-os/blob/HEAD/documents/speculative-refactoring.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--info)" }}
            >
              the speculative-refactoring doc
            </a>{" "}
            for the full flow.
          </div>
          <RelationStrip
            items={[
              { label: "Approvals", href: "/approvals", title: "Approval queue gating commit" },
              { label: "Recipes", href: "/recipes", title: "Recipes that stage edits" },
              { label: "Activity", href: "/activity", title: "Live event firehose" },
              { label: "Runs", href: "/runs", title: "Runs that produced these edits" },
            ]}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {expiredIds.length > 0 && !confirmingExpired && (
            <button
              type="button"
              className="btn sm"
              onClick={() => void discardAllExpired()}
              title={`Discard ${expiredIds.length} expired transaction${expiredIds.length === 1 ? "" : "s"}`}
            >
              Discard expired ({expiredIds.length})
            </button>
          )}
          {confirmingExpired && (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)" }}>
                Discard {expiredIds.length} expired?
              </span>
              <button
                type="button"
                className="btn sm danger"
                onClick={() => void discardAllExpired()}
              >
                Confirm
              </button>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setConfirmingExpired(false)}
              >
                Cancel
              </button>
            </span>
          )}
          <span className="pill muted">
            {transactions.length} active
          </span>
        </div>
      </div>

      <HintCard id="transactions" />

      {loading && transactions.length === 0 && (
        <SkeletonList rows={6} columns={5} />
      )}
      {error && transactions.length === 0 && (
        <ErrorState
          title="Couldn't load transactions"
          description="The bridge isn't responding to /transactions. The next poll will try again automatically."
          error={error}
        />
      )}
      {error && transactions.length > 0 && (
        <div className="alert-err" role="alert">Refresh failed — {error}</div>
      )}

      {!loading && transactions.length === 0 && (
        <EmptyState
          title="No active transactions"
          description={
            <>
              Transactions are staged multi-file edits waiting for a commit. When an agent calls <code>beginTransaction</code> + <code>stageEdit</code>, the edits appear here. Nothing touches disk until <code>commitTransaction</code> fires — so it&apos;s always safe to discard.
            </>
          }
        />
      )}

      {transactions.map((tx, txIdx) => {
        const totalDelta = tx.edits.reduce((s, e) => s + e.lineDelta, 0);
        const state = busy[tx.id];
        const isExpired = tx.expiresAt <= Date.now();
        return (
          <div
            key={tx.id}
            className="card tx-card"
            style={{ marginTop: "var(--s-4)", animationDelay: `${txIdx * 60}ms`, borderLeft: isExpired ? "3px solid var(--err)" : "3px solid var(--ok)" }}
          >
            <div className="card-head">
              <h2>
                <code style={{ fontSize: "var(--fs-base)" }}>{tx.id}</code>
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
                    <tr key={e.filePath} className="tx-table-row">
                      <td className="mono">{e.filePath}</td>
                      <td className="mono muted" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}>{formatBytes(e.sizeBefore)}</td>
                      <td className="mono tx-amount">{formatBytes(e.sizeAfter)}</td>
                      <td
                        className="mono tx-amount"
                        style={{
                          color:
                            e.lineDelta > 0
                              ? "var(--ok)"
                              : e.lineDelta < 0
                                ? "var(--err)"
                                : "var(--ink-2)",
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
                aria-label={`Discard transaction ${tx.id}`}
              >
                {state === "rolling-back" ? "Discarding…" : "Discard"}
              </button>
              <span style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)" }}>
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
