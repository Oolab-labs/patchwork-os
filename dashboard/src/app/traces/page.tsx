"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relTime } from "@/components/time";
import { apiPath } from "@/lib/api";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { arr, isRecord, shape, type ShapeCheck } from "@/lib/validate";
import { ErrorState, LivePill } from "@/components/patchwork";
import { ActivityTabs } from "@/components/ActivityTabs";

type TraceType = "approval" | "enrichment" | "recipe_run" | "decision";

interface DecisionTrace {
  traceType: TraceType;
  ts: number;
  key: string;
  summary: string;
  body: Record<string, unknown>;
}

interface TracesResponse {
  traces: DecisionTrace[];
  count: number;
  sources: {
    approval: boolean;
    enrichment: boolean;
    recipe_run: boolean;
    decision: boolean;
  };
}

const validateTraces: ShapeCheck<TracesResponse> = shape(
  "/traces",
  (raw, errors) => {
    if (!isRecord(raw)) {
      errors.push({ path: "$", reason: "expected object" });
      return null;
    }
    arr(raw, "traces", errors);
    if (typeof raw.count !== "number") {
      errors.push({ path: "count", reason: "expected number" });
    }
    if (!isRecord(raw.sources)) {
      errors.push({ path: "sources", reason: "expected object" });
    }
    if (errors.length > 0) return null;
    return raw as unknown as TracesResponse;
  },
);

const TYPE_THEME: Record<
  TraceType,
  { fg: string; bg: string; pill: string }
> = {
  approval: { fg: "var(--amber)", bg: "var(--amber-soft)", pill: "warn" },
  enrichment: { fg: "var(--green)", bg: "var(--green-soft)", pill: "ok" },
  recipe_run: { fg: "var(--blue)", bg: "var(--blue-soft)", pill: "info" },
  decision: { fg: "var(--purple)", bg: "var(--purple-soft)", pill: "purp" },
};

function traceStatus(t: DecisionTrace): "done" | "error" | "running" {
  const s = String(t.body?.status ?? t.body?.outcome ?? "").toLowerCase();
  if (s === "ok" || s === "done" || s === "success" || s === "approved") return "done";
  if (s === "error" || s === "failed" || s === "rejected" || s === "errored") return "error";
  return "running";
}

// ------------------------------------------------------------------ detail panel

const SCALAR_KEYS_FIRST = ["status", "trigger", "recipeName", "taskId", "durationMs", "seq"];

function TraceActions({
  traceType,
  body,
}: {
  traceType: TraceType;
  body: Record<string, unknown>;
}) {
  const [replaying, setReplaying] = useState(false);
  const [replayMsg, setReplayMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const recipeName = typeof body.recipeName === "string" ? body.recipeName : null;

  const cliCmd = useMemo(() => {
    if (traceType === "recipe_run" && recipeName) {
      return `patchwork recipe run ${recipeName}`;
    }
    if (traceType === "approval" && typeof body.callId === "string") {
      return `patchwork approve ${body.callId}`;
    }
    return null;
  }, [traceType, recipeName, body]);

  const handleReplay = useCallback(async () => {
    if (!recipeName) return;
    setReplaying(true);
    setReplayMsg(null);
    try {
      const res = await fetch(apiPath(`/api/bridge/recipes/${encodeURIComponent(recipeName)}/run`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; taskId?: string; error?: string };
      if (res.ok && data.ok !== false) {
        setReplayMsg({ ok: true, text: data.taskId ? `Queued → task ${data.taskId.slice(0, 8)}` : "Queued" });
      } else {
        setReplayMsg({ ok: false, text: data.error ?? `Error ${res.status}` });
      }
    } catch (e) {
      setReplayMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setReplaying(false);
    }
  }, [recipeName]);

  const handleCopyCli = useCallback(() => {
    if (!cliCmd) return;
    void navigator.clipboard.writeText(cliCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [cliCmd]);

  if (traceType !== "recipe_run" && !cliCmd) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-2)",
        padding: "8px 12px",
        borderTop: "1px solid var(--line-2)",
        background: "var(--recess)",
      }}
    >
      {traceType === "recipe_run" && recipeName && (
        <button
          type="button"
          className="btn sm primary"
          style={{ fontSize: 11, background: "var(--orange)", border: "none" }}
          disabled={replaying}
          onClick={() => void handleReplay()}
        >
          {replaying ? "Running…" : "↺ Replay"}
        </button>
      )}
      {cliCmd && (
        <button
          type="button"
          className="btn sm ghost"
          style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
          onClick={handleCopyCli}
        >
          {copied ? "Copied ✓" : "⌗ Open in CLI"}
        </button>
      )}
      {replayMsg && (
        <span
          style={{
            fontSize: 11,
            color: replayMsg.ok ? "var(--ok)" : "var(--err)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {replayMsg.text}
        </span>
      )}
    </div>
  );
}

function TraceDetail({
  body,
  theme,
  traceType,
}: {
  body: Record<string, unknown>;
  theme: { fg: string; bg: string };
  traceType: TraceType;
}) {
  const entries = Object.entries(body);
  const scalars = entries.filter(
    ([, v]) => typeof v !== "object" || v === null,
  );
  const objects = entries.filter(
    ([, v]) => typeof v === "object" && v !== null,
  );
  // Put well-known keys first
  scalars.sort(([a], [b]) => {
    const ai = SCALAR_KEYS_FIRST.indexOf(a);
    const bi = SCALAR_KEYS_FIRST.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return (
    <div
      style={{
        margin: "0 16px 14px 36px",
        borderRadius: "var(--r-s)",
        border: "1px solid var(--line-2)",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      {/* scalar fields as key/value grid */}
      {scalars.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            background: "var(--recess)",
          }}
        >
          {scalars.map(([k, v], i) => (
            <Fragment key={k}>
              <div
                style={{
                  padding: "5px 12px",
                  fontFamily: "var(--font-mono)",
                  color: theme.fg,
                  fontWeight: 600,
                  fontSize: 11,
                  background: i % 2 === 0 ? "rgba(0,0,0,0.06)" : "transparent",
                  borderRight: "1px solid var(--line-2)",
                  whiteSpace: "nowrap",
                }}
              >
                {k}
              </div>
              <div
                style={{
                  padding: "5px 12px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-1)",
                  fontSize: 11,
                  background: i % 2 === 0 ? "rgba(0,0,0,0.06)" : "transparent",
                  wordBreak: "break-all",
                }}
              >
                {String(v)}
              </div>
            </Fragment>
          ))}
        </div>
      )}
      {/* complex fields as collapsible JSON */}
      {objects.map(([k, v]) => (
        <details key={k} style={{ borderTop: "1px solid var(--line-2)" }}>
          <summary
            style={{
              padding: "5px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              color: theme.fg,
              cursor: "pointer",
              background: "var(--recess)",
              listStyle: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ color: "var(--ink-3)", fontSize: 9 }}>▸</span>
            {k}
            {Array.isArray(v) && (
              <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
                [{(v as unknown[]).length}]
              </span>
            )}
          </summary>
          <pre
            style={{
              margin: 0,
              padding: "8px 12px 10px 24px",
              background: "var(--bg-0)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--ink-2)",
            }}
          >
            {JSON.stringify(v, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

type SinceFilter = "1h" | "24h" | "7d" | "30d" | "all";

const SINCE_OPTIONS: { k: SinceFilter; label: string; ms: number | null }[] = [
  { k: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { k: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { k: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { k: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { k: "all", label: "All time", ms: null },
];

function ExportButton({ disabled: outerDisabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleDownload() {
    const phrase = passphrase.trim();
    if (phrase && phrase.length < 12) {
      setError("Passphrase must be at least 12 characters.");
      return;
    }
    setError(null);
    setDownloading(true);
    try {
      const headers: Record<string, string> = {};
      if (phrase) headers["x-trace-passphrase"] = phrase;
      const res = await fetch(apiPath("/api/bridge/traces/export"), { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = phrase ? "traces-export.enc" : "traces-export.jsonl.gz";
      a.click();
      URL.revokeObjectURL(url);
      setOpen(false);
      setPassphrase("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn sm"
        onClick={() => setOpen((v) => !v)}
        disabled={outerDisabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{ opacity: outerDisabled ? 0.4 : 1 }}
      >
        Export
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            background: "var(--bg-2)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            padding: "var(--s-4)",
            minWidth: 280,
            zIndex: 10,
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          }}
        >
          <p style={{ margin: "0 0 var(--s-3)", fontSize: 12, color: "var(--fg-2)" }}>
            Optional: encrypt with a passphrase (AES-256-GCM). Leave blank for a
            plain <code>.jsonl.gz</code>.
          </p>
          <input
            type="password"
            placeholder="Passphrase (optional)"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleDownload(); }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              marginBottom: "var(--s-3)",
              padding: "6px 10px",
              background: "var(--bg-3)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              color: "var(--fg-1)",
              fontSize: 13,
            }}
            autoFocus
          />
          {error && (
            <p style={{ margin: "0 0 var(--s-3)", fontSize: 12, color: "var(--red)" }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-end" }}>
            <button type="button" className="btn sm" onClick={() => { setOpen(false); setPassphrase(""); setError(null); }}>
              Cancel
            </button>
            <button type="button" className="btn sm primary" onClick={handleDownload} disabled={downloading}>
              {downloading ? "Downloading…" : passphrase.trim() ? "Download encrypted" : "Download"}
            </button>
          </div>
          {passphrase.trim() && (
            <p style={{ margin: "var(--s-3) 0 0", fontSize: 11, color: "var(--fg-3)" }}>
              Import: <code>patchwork traces import bundle.enc --passphrase …</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function TracesPage() {
  const [statusFilter, setStatusFilter] = useState<"all" | "done" | "errors">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [since, setSince] = useState<SinceFilter>("24h");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    if (searchQuery.trim()) {
      params.set("key", searchQuery.trim());
      params.set("q", searchQuery.trim());
    }
    const sinceMs = SINCE_OPTIONS.find((o) => o.k === since)?.ms;
    if (sinceMs != null) {
      params.set("since", String(Date.now() - sinceMs));
    }
    params.set("limit", "50");
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [searchQuery, since]);

  const { data, error, loading } = useBridgeFetch<TracesResponse>(
    `/api/bridge/traces${qs}`,
    { intervalMs: 3000, transform: validateTraces },
  );

  const traces = data?.traces ?? [];

  const flatSorted = useMemo(() => [...traces].sort((a, b) => b.ts - a.ts), [traces]);

  const visible = useMemo(() => {
    if (statusFilter === "all") return flatSorted;
    return flatSorted.filter(t => {
      const s = traceStatus(t);
      if (statusFilter === "done") return s === "done";
      if (statusFilter === "errors") return s === "error";
      return true;
    });
  }, [flatSorted, statusFilter]);

  const doneCount = flatSorted.filter(t => traceStatus(t) === "done").length;
  const errorCount = flatSorted.filter(t => traceStatus(t) === "error").length;

  const toggle = (rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Traces — <em className="accent" style={{ fontStyle: "italic" }}>recipe runs and their decision logs.</em>
          </h1>
          <div className="editorial-sub" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>{traces.length} traces · {doneCount} done · {errorCount} errors</span>
            <LivePill label="3s" tone="muted" />
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter recipe or trace id…"
            style={{
              minWidth: 260,
              padding: "6px 10px",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              background: "var(--recess)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-s)",
              color: "var(--ink-0)",
            }}
          />
          <ExportButton disabled={traces.length === 0} />
        </div>
      </div>

      {/* filter bar */}
      <div
        style={{
          display: "flex",
          gap: "var(--s-3)",
          marginBottom: "var(--s-4)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div className="filter-chips" style={{ marginBottom: 0 }}>
          {(["all", "done", "errors"] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setStatusFilter(k)}
              className={statusFilter === k ? "pill accent" : "pill muted"}
              style={{ cursor: "pointer", border: "none", fontSize: 12 }}
            >
              {k === "all" ? `All (${traces.length})` : k === "done" ? `Done (${doneCount})` : `Errors (${errorCount})`}
            </button>
          ))}
        </div>
      </div>

      {loading && traces.length === 0 && (
        <p style={{ color: "var(--fg-2)" }}>Loading…</p>
      )}

      {error && traces.length === 0 && (
        <ErrorState
          title={error.startsWith("/traces") ? "Bridge version mismatch" : "Couldn't load traces"}
          description={
            error.startsWith("/traces")
              ? "The /traces response didn't match the schema this dashboard expects. Check that the bridge and dashboard versions match."
              : "The bridge isn't responding. Traces will reload on its next tick."
          }
          error={error}
          onRetry={() => window.location.reload()}
        />
      )}
      {error && traces.length > 0 && (
        <div className="alert-err">
          {error.startsWith("/traces")
            ? `Response shape unexpected (bridge version mismatch?): ${error}`
            : `Refresh failed — ${error}`}
        </div>
      )}

      {visible.length === 0 && !loading ? (
        <div className="empty-state">
          <h3>No traces</h3>
          <p>Traces appear as recipes run and approvals are processed.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: "var(--s-5)" }}>
          {visible.map(t => {
            const rowKey = `${t.traceType}:${t.ts}:${t.key}`;
            const isOpen = expanded.has(rowKey);
            const status = traceStatus(t);
            const theme = TYPE_THEME[t.traceType];
            const statusColor = status === "done" ? "var(--ok)" : status === "error" ? "var(--err)" : "var(--ink-3)";
            const statusBg = status === "done" ? "var(--ok-soft)" : status === "error" ? "var(--err-soft)" : "var(--recess)";
            const statusLabel = status === "done" ? "done" : status === "error" ? "error" : "running";
            return (
              <div key={rowKey} style={{ borderBottom: "1px solid var(--line-3)" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "20px 18px minmax(280px, auto) 1fr 100px 80px 28px",
                    alignItems: "center",
                    gap: "var(--s-3)",
                    width: "100%",
                    padding: "10px 16px",
                    minHeight: 44,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggle(rowKey)}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--ink-3)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      padding: 0,
                      textAlign: "left",
                    }}
                  >
                    {isOpen ? "v" : ">"}
                  </button>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      background: theme.bg,
                      border: `1px solid ${theme.fg}`,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => toggle(rowKey)}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: theme.fg,
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.key}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(rowKey)}
                    style={{
                      fontSize: 13,
                      color: "var(--ink-1)",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {String(t.body?.recipeName ?? t.key)}
                  </button>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", textAlign: "right" }}>
                    {relTime(t.ts)}
                  </span>
                  <span style={{ display: "flex", justifyContent: "flex-end" }}>
                    <span className="pill" style={{ background: statusBg, color: statusColor, fontSize: 10, fontWeight: 700 }}>
                      {statusLabel}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label="Copy trace id"
                    onClick={() => { void navigator.clipboard.writeText(t.key); }}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--ink-3)",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
                {isOpen && (
                  <div style={{ padding: "0 16px 12px 16px", borderTop: "1px solid var(--line-3)", background: "var(--recess)" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)", margin: "8px 0 4px", wordBreak: "break-all" }}>
                      {t.key}
                    </div>
                    {t.summary && (
                      <div style={{ fontSize: 12, color: "var(--ink-1)", marginBottom: 8 }}>{t.summary}</div>
                    )}
                    <TraceActions traceType={t.traceType} body={t.body} />
                    <TraceDetail body={t.body} theme={theme} traceType={t.traceType} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
