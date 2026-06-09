"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { relTime } from "@/components/time";
import { apiPath } from "@/lib/api";
import { canonicalRecipeKey } from "@/lib/entityKey";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { useDebounced } from "@/hooks/useDebounced";
import { arr, isRecord, shape, type ShapeCheck } from "@/lib/validate";
import { EmptyState, ErrorState, HintCard, LivePill, RelationStrip } from "@/components/patchwork";
import { ApprovalChip, RecipeChip } from "@/components/patchwork/entity";
import { ActivityTabs } from "@/components/ActivityTabs";
import { SkeletonList } from "@/components/Skeleton";

type TraceType = "approval" | "enrichment" | "recipe_run" | "decision";

interface DecisionTrace {
  traceType: TraceType;
  ts: number;
  key: string;
  summary: string;
  body: Record<string, unknown>;
  tags?: string[];
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
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);

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
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [cliCmd]);

  if (traceType !== "recipe_run" && !cliCmd) return null;

  return (
    <div className="traces-actions-bar">
      {traceType === "recipe_run" && recipeName && (
        <button
          type="button"
          className="btn sm primary traces-replay-btn"
          disabled={replaying}
          onClick={() => void handleReplay()}
        >
          {replaying ? "Running…" : "↺ Replay"}
        </button>
      )}
      {cliCmd && (
        <button
          type="button"
          className="btn sm ghost traces-cli-btn"
          onClick={handleCopyCli}
        >
          {copied ? "Copied ✓" : "⌗ Open in CLI"}
        </button>
      )}
      {replayMsg && (
        <span className="traces-replay-msg" data-ok={String(replayMsg.ok)}>
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
    <div className="traces-detail">
      {/* scalar fields as key/value grid */}
      {scalars.length > 0 && (
        <div className="traces-detail-scalars">
          {scalars.map(([k, v], i) => (
            <Fragment key={k}>
              <div
                className="traces-detail-key"
                data-odd={String(i % 2 === 1)}
                style={{ color: theme.fg }}
              >
                {k}
              </div>
              <div
                className="traces-detail-val"
                data-odd={String(i % 2 === 1)}
              >
                {String(v)}
              </div>
            </Fragment>
          ))}
        </div>
      )}
      {/* complex fields as collapsible JSON */}
      {objects.map(([k, v]) => (
        <details key={k} className="traces-detail-object">
          <summary className="traces-detail-summary" style={{ color: theme.fg }}>
            <span className="traces-detail-arrow">▸</span>
            {k}
            {Array.isArray(v) && (
              <span className="traces-detail-count">[{(v as unknown[]).length}]</span>
            )}
          </summary>
          <pre className="traces-detail-pre">
            {JSON.stringify(v, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ span tree

type SpanGroup = {
  root: DecisionTrace;
  children: DecisionTrace[];
};

function buildSpanGroups(traces: DecisionTrace[]): SpanGroup[] {
  const roots = traces.filter((t) => t.traceType === "recipe_run");
  const nonRoots = traces.filter((t) => t.traceType !== "recipe_run");

  // Group roots by recipeName
  const rootsByRecipe = new Map<string, DecisionTrace[]>();
  for (const r of roots) {
    const name = typeof r.body.recipeName === "string" ? r.body.recipeName : r.key;
    const arr = rootsByRecipe.get(name) ?? [];
    arr.push(r);
    rootsByRecipe.set(name, arr);
  }

  const groups: SpanGroup[] = [];
  const assignedKeys = new Set<string>();

  for (const r of roots) {
    if (assignedKeys.has(r.key)) continue;
    assignedKeys.add(r.key);

    const recipeName = typeof r.body.recipeName === "string" ? r.body.recipeName : null;
    let children: DecisionTrace[] = [];

    if (recipeName !== null) {
      // Find children: same recipeName, not a root, not already assigned
      const candidates = nonRoots.filter(
        (t) => typeof t.body.recipeName === "string" && t.body.recipeName === recipeName && !assignedKeys.has(t.key),
      );
      // Find the root closest in time for each child
      const rootsForRecipe = rootsByRecipe.get(recipeName) ?? [r];
      children = candidates.filter((child) => {
        const closest = rootsForRecipe.reduce((best, candidate) =>
          Math.abs(candidate.ts - child.ts) < Math.abs(best.ts - child.ts) ? candidate : best,
        );
        return closest.key === r.key;
      });
      for (const c of children) assignedKeys.add(c.key);
    }

    children.sort((a, b) => a.ts - b.ts);
    groups.push({ root: r, children });
  }

  // Remaining traces become singletons
  for (const t of traces) {
    if (!assignedKeys.has(t.key)) {
      groups.push({ root: t, children: [] });
    }
  }

  // Sort groups by root.ts descending
  groups.sort((a, b) => b.root.ts - a.root.ts);
  return groups;
}

// ------------------------------------------------------------------ waterfall bar

function SpanBar({
  startMs,
  durationMs,
  groupStartMs,
  groupEndMs,
  color,
  label,
}: {
  startMs: number;
  durationMs: number;
  groupStartMs: number;
  groupEndMs: number;
  color: string;
  label?: string;
}) {
  const range = groupEndMs - groupStartMs;
  // The bar was previously unreadable: `label` was declared but never
  // rendered, so the track carried no hover tooltip or screen-reader text and
  // children passed no label at all. Surface it as title + aria-label on the
  // track in every branch, falling back to the duration.
  const barLabel = label ?? (durationMs > 0 ? `${durationMs}ms` : "instant");

  if (range <= 0) {
    return (
      <div className="traces-span-track" title={barLabel} aria-label={barLabel}>
        <div className="traces-span-fill" style={{ inset: 0, background: color }} />
      </div>
    );
  }

  const leftPct = ((startMs - groupStartMs) / range) * 100;

  if (durationMs <= 0) {
    return (
      <div className="traces-span-track" title={barLabel} aria-label={barLabel}>
        <div
          className="traces-span-tick"
          style={{ left: `${Math.min(leftPct, 98)}%`, background: color }}
        />
      </div>
    );
  }

  const widthPct = Math.max(2, (durationMs / range) * 100);

  return (
    <div className="traces-span-track" title={barLabel} aria-label={barLabel}>
      <div
        className="traces-span-fill"
        style={{
          left: `${Math.min(leftPct, 96)}%`,
          width: `${Math.min(widthPct, 100 - Math.min(leftPct, 96))}%`,
          height: "100%",
          background: color,
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ since filter

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
    <div ref={wrapRef} className="traces-export-wrap">
      <button
        type="button"
        className="btn sm"
        onClick={() => setOpen((v) => !v)}
        disabled={outerDisabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        {...(outerDisabled ? { "data-disabled": "" } : {})}
      >
        Export
      </button>
      {open && (
        <div className="traces-export-panel">
          <p className="traces-export-hint">
            Optional: encrypt with a passphrase (AES-256-GCM). Leave blank for a
            plain <code>.jsonl.gz</code>.
          </p>
          <input
            type="password"
            placeholder="Passphrase (optional)"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleDownload(); }}
            className="traces-export-input"
            autoFocus
          />
          {error && <p className="traces-export-err">{error}</p>}
          <div className="traces-export-actions">
            <button type="button" className="btn sm" onClick={() => { setOpen(false); setPassphrase(""); setError(null); }}>
              Cancel
            </button>
            <button type="button" className="btn sm primary" onClick={handleDownload} disabled={downloading}>
              {downloading ? "Downloading…" : passphrase.trim() ? "Download encrypted" : "Download"}
            </button>
          </div>
          {passphrase.trim() && (
            <p className="traces-export-note">
              Import: <code>patchwork traces import bundle.enc --passphrase …</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function isSinceFilter(v: string | null): v is SinceFilter {
  return v === "1h" || v === "24h" || v === "7d" || v === "30d" || v === "all";
}

export default function TracesPage() {
  const searchParams = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<"all" | "done" | "errors">("all");
  // Inbound deep-links: /traces?recipe=<name> (from /runs, /recipes, etc.)
  // and /traces?q=<free-text> previously landed on an unfiltered page —
  // the destination ignored the param entirely. Seed the search box from
  // either, preferring ?recipe= (canonicalised via canonicalRecipeKey so
  // a "foo:agent" axis variant resolves to the bare recipe). Also honor
  // ?since= when it's a known bucket key.
  const initialRecipe = useMemo(() => {
    const r = searchParams?.get("recipe");
    return r ? canonicalRecipeKey(r) : "";
  }, [searchParams]);
  const initialQ = searchParams?.get("q") ?? "";
  const initialSince = searchParams?.get("since");
  const [searchQuery, setSearchQuery] = useState<string>(initialRecipe || initialQ);
  const [recipeFilter, setRecipeFilter] = useState<string>(initialRecipe);
  const debouncedSearch = useDebounced(searchQuery, 250);
  const [since, setSince] = useState<SinceFilter>(
    isSinceFilter(initialSince) ? initialSince : "24h",
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"flat" | "tree">("tree");
  const [ksOnly, setKsOnly] = useState(false);
  // Opt-in meaning-based ranking (cosine over the configured on-device
  // embeddings model). Server-side it falls back to substring when no
  // embeddings endpoint is configured, so this is always safe to toggle.
  const [semantic, setSemantic] = useState(false);

  // Re-seed on URL change (e.g. user clicks another ?recipe= chip without
  // a full page nav). Keep this minimal — only re-apply when the inbound
  // param differs from current state, so user typing isn't trampled.
  useEffect(() => {
    const r = searchParams?.get("recipe");
    const canon = r ? canonicalRecipeKey(r) : "";
    if (canon && canon !== recipeFilter) {
      setRecipeFilter(canon);
      setSearchQuery(canon);
    } else if (!r && recipeFilter) {
      // ?recipe= was cleared from the URL externally — drop the filter.
      setRecipeFilter("");
    }
    const q = searchParams?.get("q");
    if (q && q !== searchQuery && !canon) {
      setSearchQuery(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const clearRecipeFilter = useCallback(() => {
    setRecipeFilter("");
    setSearchQuery("");
    if (typeof globalThis !== "undefined" && globalThis.location) {
      const url = new URL(globalThis.location.href);
      let dirty = false;
      for (const k of ["recipe", "q"]) {
        if (url.searchParams.has(k)) {
          url.searchParams.delete(k);
          dirty = true;
        }
      }
      if (dirty) globalThis.history.replaceState(null, "", url.toString());
    }
  }, []);

  const qs = useMemo(() => {
    const params = new URLSearchParams();
    const term = debouncedSearch.trim();
    if (term) {
      params.set("q", term);
      // `key` is a hard substring filter; skip it in meaning-mode so cosine
      // ranks across ALL traces instead of only key-matching ones.
      if (semantic) {
        params.set("semantic", "true");
      } else {
        params.set("key", term);
      }
    }
    const sinceMs = SINCE_OPTIONS.find((o) => o.k === since)?.ms;
    if (sinceMs != null) {
      params.set("since", String(Date.now() - sinceMs));
    }
    params.set("limit", "50");
    if (ksOnly) {
      params.set("tag", "kill-switch");
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [debouncedSearch, since, ksOnly, semantic]);

  const { data, error, loading, refetch } = useBridgeFetch<TracesResponse>(
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
  // Header used to read "50 traces · 34 done · 1 errors" — readers expected
  // the parts to add up. Surfaced here so 50 = 34 + 1 + 15 stays obvious.
  const runningCount = flatSorted.length - doneCount - errorCount;

  const toggle = (rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const isSearching = searchQuery !== debouncedSearch;

  return (
    <section>
      <ActivityTabs />
      <div className="page-head">
        <div>
          <div className="page-head-title-row">
            <h1 className="editorial-h1">
              Traces — <em className="accent traces-heading-em">recipe runs and their decision logs.</em>
            </h1>
            <HintCard.Toggle id="traces" />
          </div>
          <div className="editorial-sub traces-sub">
            <span>
              {traces.length} traces · {doneCount} done · {errorCount} error{errorCount === 1 ? "" : "s"}
              {runningCount > 0 ? ` · ${runningCount} running` : ""} ·{" "}
              {SINCE_OPTIONS.find((o) => o.k === since)?.label.toLowerCase() ?? since}
            </span>
            <LivePill label="3s" tone="muted" />
          </div>
          <RelationStrip
            items={[
              { label: "Knowledge", href: "/decisions", title: "Saved reasoning your agents wrote down" },
              { label: "Approvals", href: "/approvals", title: "Approvals these traces touched" },
              { label: "Runs", href: "/runs", title: "Recipe runs these traces came from" },
              { label: "Insights", href: "/insights", title: "Cross-tool approval patterns" },
            ]}
          />
        </div>
        <div className="traces-toolbar" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter traces"
              placeholder="Filter recipe or trace id…"
              className="traces-search-input"
            />
            {isSearching && (
              <span className="traces-search-loading" aria-label="Searching…" title="Searching…" />
            )}
          </div>
          <button
            type="button"
            onClick={() => setSemantic((v) => !v)}
            disabled={!debouncedSearch.trim()}
            aria-pressed={semantic}
            title="Rank results by meaning (on-device embeddings) instead of exact words. Falls back to word match when no local model is configured."
            className={semantic ? "pill info traces-filter-pill" : "pill muted traces-filter-pill"}
          >
            By meaning
          </button>
          <ExportButton disabled={traces.length === 0} />
        </div>
      </div>

      <HintCard id="traces" />

      {recipeFilter && (
        <div className="traces-recipe-filter">
          <span className="traces-recipe-filter-label">Filtered by recipe:</span>
          <span className="mono traces-recipe-filter-name">{recipeFilter}</span>
          <button type="button" className="btn sm ghost traces-recipe-filter-clear" onClick={clearRecipeFilter}>
            Clear
          </button>
        </div>
      )}

      {/* filter bar */}
      <div className="traces-filter-bar">
        <div className="filter-chips traces-filter-chips">
          {(["all", "done", "errors"] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setStatusFilter(k)}
              className={statusFilter === k ? "pill info traces-filter-pill" : "pill muted traces-filter-pill"}
            >
              {k === "all" ? `All (${traces.length})` : k === "done" ? `Done (${doneCount})` : `Errors (${errorCount})`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setKsOnly((v) => !v)}
            className={ksOnly ? "pill info traces-filter-pill traces-ks-pill" : "pill muted traces-filter-pill"}
          >
            Kill-switch
          </button>
        </div>
        <label className="traces-since-label">
          <span>since</span>
          <select
            value={since}
            onChange={(e) => setSince(e.target.value as SinceFilter)}
            className="traces-since-select"
          >
            {SINCE_OPTIONS.map((o) => (
              <option key={o.k} value={o.k}>{o.label}</option>
            ))}
          </select>
        </label>
        <div className="filter-chips traces-filter-chips">
          <span className="traces-view-label">View:</span>
          {(["flat", "tree"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={view === v ? "pill info traces-filter-pill traces-view-pill" : "pill muted traces-filter-pill traces-view-pill"}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Type-color legend — the waterfall bar + row-icon colors encode the
          trace type; without a key those colors are meaningless (facelift
          addendum, Traces waterfall pass). */}
      <div className="traces-legend" aria-label="Trace type colors">
        {(Object.entries(TYPE_THEME) as Array<[TraceType, (typeof TYPE_THEME)[TraceType]]>).map(
          ([type, theme]) => (
            <span key={type} className="traces-legend-item">
              <span
                className="traces-legend-swatch"
                style={{ background: theme.fg }}
                aria-hidden="true"
              />
              {type.replace(/_/g, " ")}
            </span>
          ),
        )}
      </div>

      {loading && traces.length === 0 && (
        <SkeletonList rows={6} columns={4} />
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
          onRetry={refetch}
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
        <EmptyState
          title="No decisions recorded yet"
          description="Every approval, recipe run, and agent decision is saved here automatically. Run a recipe or approve a tool call to see your first entry."
          action={
            <Link href="/recipes" className="btn sm">
              Browse recipes
            </Link>
          }
        />
      ) : view === "flat" ? (
        // #600: switch `overflow: hidden` → `overflow-x: auto` so the
        // wide 7-col table can horizontally scroll INSIDE the card on
        // phones instead of pushing the whole page wider than the
        // viewport. Each row keeps its columnar layout (the alternative
        // — stacking cells vertically per row — destroys the table
        // affordance, which is the whole point of this view).
        <div className="card traces-card">
          {visible.map((t, rowIdx) => {
            const rowKey = `${t.traceType}:${t.ts}:${t.key}`;
            const isOpen = expanded.has(rowKey);
            const status = traceStatus(t);
            const theme = TYPE_THEME[t.traceType];
            const isKillSwitch = Array.isArray(t.tags) && t.tags.includes("kill-switch");
            return (
              <div
                key={rowKey}
                className={`traces-row traces-row--${t.traceType}`}
                style={{ animationDelay: `${Math.min(rowIdx * 20, 200)}ms` }}
                {...(isKillSwitch ? { "data-ks": "" } : {})}
              >
                <div className="traces-row-grid">
                  <button type="button" onClick={() => toggle(rowKey)} aria-label={isOpen ? "Collapse" : "Expand"} className="traces-expand-btn">
                    {isOpen ? "v" : ">"}
                  </button>
                  <span aria-hidden="true" className="traces-type-icon" style={{ background: theme.bg, border: `1px solid ${theme.fg}` }} />
                  <button type="button" onClick={() => toggle(rowKey)} className="traces-key-btn" style={{ color: theme.fg }}>
                    {t.key}
                  </button>
                  <div className="traces-recipe-col">
                    <button
                      type="button"
                      onClick={() => toggle(rowKey)}
                      aria-label={isOpen ? "Collapse details" : "Expand details"}
                      className="traces-recipe-btn"
                      data-has-recipe={String(typeof t.body?.recipeName === "string")}
                    >
                      {typeof t.body?.recipeName === "string" ? t.body.recipeName : "—"}
                    </button>
                    {typeof t.body?.recipeName === "string" && (
                      <RecipeChip name={t.body.recipeName} variant="link" />
                    )}
                    {t.traceType === "approval" && typeof t.body?.callId === "string" && (
                      <ApprovalChip callId={t.body.callId} variant="link" />
                    )}
                  </div>
                  <span className="traces-ts">{relTime(t.ts)}</span>
                  <span className="traces-pill-wrap">
                    <span className="pill traces-status-pill" data-status={status}>
                      {status === "done" ? "done" : status === "error" ? "error" : "running"}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label="Copy trace id"
                    onClick={() => { void navigator.clipboard.writeText(t.key); }}
                    className="traces-copy-btn"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2v1" />
                    </svg>
                  </button>
                </div>
                {isOpen && (
                  <div className="traces-detail-panel">
                    <div className="traces-detail-key-text">{t.key}</div>
                    {t.summary && <div className="traces-detail-summary-text">{t.summary}</div>}
                    <TraceActions traceType={t.traceType} body={t.body} />
                    <TraceDetail body={t.body} theme={theme} traceType={t.traceType} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        // Tree view
        // #600: same overflow-x: auto pattern as the flat view above.
        <div className="card traces-card">
          {buildSpanGroups(visible).map((group) => {
            const { root, children } = group;
            const rootKey = `${root.traceType}:${root.ts}:${root.key}`;
            const isOpen = expanded.has(rootKey);
            const rootStatus = traceStatus(root);
            const rootTheme = TYPE_THEME[root.traceType];

            const rootDuration = typeof root.body.durationMs === "number" ? root.body.durationMs : 0;
            const childrenEnd = children.reduce((max, c) => {
              const cd = typeof c.body.durationMs === "number" ? c.body.durationMs : 0;
              return Math.max(max, c.ts + cd);
            }, root.ts);
            const groupStartMs = root.ts;
            const groupEndMs = rootDuration > 0 ? root.ts + rootDuration : childrenEnd;

            return (
              <div key={rootKey} className={`traces-row traces-row--${root.traceType}`}>
                {/* Root row */}
                <div className="traces-root-grid">
                  <button type="button" onClick={() => toggle(rootKey)} aria-label={isOpen ? "Collapse" : "Expand"} className="traces-expand-btn">
                    {isOpen ? "v" : ">"}
                  </button>
                  <span aria-hidden="true" className="traces-type-icon" style={{ background: rootTheme.bg, border: `1px solid ${rootTheme.fg}` }} />
                  <button type="button" onClick={() => toggle(rootKey)} className="traces-key-btn" style={{ color: rootTheme.fg }}>
                    {root.key}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(rootKey)}
                    className="traces-recipe-btn"
                    data-has-recipe={String(typeof root.body?.recipeName === "string")}
                  >
                    {typeof root.body?.recipeName === "string" ? root.body.recipeName : "—"}
                  </button>
                  <span className="traces-ts">{relTime(root.ts)}</span>
                  <span className="traces-pill-wrap">
                    <span className="pill traces-status-pill" data-status={rootStatus}>
                      {rootStatus === "done" ? "done" : rootStatus === "error" ? "error" : "running"}
                    </span>
                  </span>
                </div>
                {/* Waterfall bar row for root */}
                <div className="traces-waterfall">
                  <div className="traces-span-bar-wrap">
                    <SpanBar
                      startMs={groupStartMs}
                      durationMs={rootDuration}
                      groupStartMs={groupStartMs}
                      groupEndMs={groupEndMs}
                      color={rootTheme.fg}
                      label={rootDuration > 0 ? `${rootDuration}ms` : undefined}
                    />
                  </div>
                  {rootDuration > 0 && (
                    <span className="traces-duration">{rootDuration}ms</span>
                  )}
                </div>
                {/* Expanded detail for root */}
                {isOpen && (
                  <>
                    <div className="traces-detail-panel">
                      <div className="traces-detail-key-text">{root.key}</div>
                      {root.summary && <div className="traces-detail-summary-text">{root.summary}</div>}
                      <TraceActions traceType={root.traceType} body={root.body} />
                      <TraceDetail body={root.body} theme={rootTheme} traceType={root.traceType} />
                    </div>
                    {/* Children rows */}
                    {children.map((child) => {
                      const childStatus = traceStatus(child);
                      const childTheme = TYPE_THEME[child.traceType];
                      const childDuration = typeof child.body.durationMs === "number" ? child.body.durationMs : 0;
                      return (
                        <div key={`${child.traceType}:${child.ts}:${child.key}`} className="traces-child-row">
                          <div className="traces-child-grid">
                            <span aria-hidden="true" className="traces-type-icon-sm" style={{ background: childTheme.bg, border: `1px solid ${childTheme.fg}` }} />
                            <span className="traces-child-key" style={{ color: childTheme.fg }}>{child.key}</span>
                            <span
                              className="traces-child-recipe"
                              data-has-recipe={String(typeof child.body?.recipeName === "string")}
                            >
                              {typeof child.body?.recipeName === "string" ? child.body.recipeName : "—"}
                            </span>
                            <span className="traces-ts">{relTime(child.ts)}</span>
                            <span className="traces-pill-wrap">
                              <span className="pill traces-status-pill" data-status={childStatus}>
                                {childStatus === "done" ? "done" : childStatus === "error" ? "error" : "running"}
                              </span>
                            </span>
                          </div>
                          {/* Waterfall bar for child */}
                          <div className="traces-waterfall traces-waterfall--child">
                            <div className="traces-span-bar-wrap">
                              <SpanBar
                                startMs={child.ts}
                                durationMs={childDuration}
                                groupStartMs={groupStartMs}
                                groupEndMs={groupEndMs}
                                color={childTheme.fg}
                                label={`${child.key} · ${childDuration > 0 ? `${childDuration}ms` : "instant"} · +${child.ts - groupStartMs}ms from start`}
                              />
                            </div>
                            {childDuration > 0 && (
                              <span className="traces-duration">{childDuration}ms</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
