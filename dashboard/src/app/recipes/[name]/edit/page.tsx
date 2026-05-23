"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
// BackLink and RelationStrip are rendered by the shared recipes/[name]/layout.tsx
import { useToast } from "@/components/Toast";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { ConnectorChip } from "@/components/patchwork";
import {
  detectConnectorsForRecipe,
  detectConnectorsFromYaml,
} from "../layout";
import type { YamlLintIssue } from "./_components/YamlEditor";
import dynamic from "next/dynamic";

/** Minimal shape we need from `/api/bridge/connectors/status` to drive
 *  the chip strip. `status` is the positive signal — `healthy` is
 *  currently always null from the bridge (Phase 1A.1 dogfood finding).
 */
interface ConnectorStatusLite {
  id: string;
  status?: "connected" | "disconnected" | "needs_reauth";
}

const YamlEditor = dynamic(() => import("./_components/YamlEditor"), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: 400, background: "var(--recess)", borderRadius: "var(--r-2)", border: "1px solid var(--line-2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
      Loading editor…
    </div>
  ),
});


/**
 * Phase 2B-A: placeholder rendered when the user switches to Form mode.
 * Subsequent PRs replace this with the real structured form fields.
 */
function RecipeFormSkeleton() {
  return (
    <div
      style={{
        minHeight: 400,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--s-4)",
        color: "var(--ink-3)",
        padding: "var(--s-6) var(--s-4)",
        textAlign: "center",
      }}
    >
      <svg
        width={40}
        height={40}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        aria-hidden="true"
      >
        <rect x={3} y={3} width={7} height={5} rx={1} />
        <rect x={14} y={3} width={7} height={5} rx={1} />
        <rect x={3} y={10} width={18} height={5} rx={1} />
        <rect x={3} y={17} width={18} height={4} rx={1} />
      </svg>
      <div>
        <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
          Form editor — coming soon
        </p>
        <p style={{ margin: "var(--s-2) 0 0", fontSize: "var(--fs-s)" }}>
          Switch back to <strong>YAML</strong> to edit for now.
          The form view will let you add and configure steps without writing YAML by hand.
        </p>
      </div>
    </div>
  );
}

export default function RecipeEditPage({
  params,
}: {
  // Next 15: dynamic route params are Promise-typed; client components
  // unwrap with React.use().
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = use(params);
  const name = decodeURIComponent(rawName);
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  // Whether the recipe didn't exist at load time. Used to show a banner so
  // the user knows they're not actually editing — they're typing into an
  // empty buffer. (Saving WILL create it; this just makes that intention
  // explicit instead of looking like the recipe loaded blank.)
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lintErrors, setLintErrors] = useState<string[]>([]);
  const [lintWarnings, setLintWarnings] = useState<string[]>([]);
  // Phase 1B: structured issues drive the CodeMirror gutter linter.
  // The display lists above continue to use plain message strings for
  // the lint banner; this state carries the line/column/code/path
  // fields needed for inline diagnostics.
  const [lintIssues, setLintIssues] = useState<YamlLintIssue[]>([]);
  // Phase 2A.2: "Fix with AI" — proposes a repaired YAML via the
  // bridge's /recipes/repair endpoint and shows the result in a
  // preview modal so the user can apply or discard. Gated behind the
  // `recipe.repair-ai` flag on the bridge side; when off the bridge
  // returns 503 feature_disabled and the dashboard renders a toast
  // pointing at Settings → Feature flags.
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairProposal, setRepairProposal] = useState<{
    yaml: string;
    warnings: string[];
  } | null>(null);
  const [linting, setLinting] = useState(false);
  // Phase 2B: edit mode toggle — "yaml" (default) or "form" (structured editor).
  // Preference is persisted to localStorage so returning users stay in their
  // chosen mode. Form mode is built incrementally: PR A (this) ships the
  // toggle + skeleton; PRs B/C add the actual form fields.
  const [editMode, setEditMode] = useState<"yaml" | "form">(() => {
    if (typeof window === "undefined") return "yaml";
    return (localStorage.getItem("recipe-edit-mode") as "yaml" | "form" | null) ?? "yaml";
  });
  const switchEditMode = useCallback((mode: "yaml" | "form") => {
    setEditMode(mode);
    localStorage.setItem("recipe-edit-mode", mode);
  }, []);
  const toast = useToast();

  // Connector preflight surfaced on the edit page (Phase 1A item 5,
  // upgraded by Phase 1A.1).
  //
  // Detect required connectors by scanning `tool:` lines in the live
  // YAML buffer — the name+description heuristic used originally missed
  // ~69% of real recipes whose connectors are only mentioned in step
  // bodies. Falls back to the name-string heuristic only if the buffer
  // is empty (e.g. while a new recipe hasn't been typed yet).
  const { data: connectorStatuses } = useBridgeFetch<ConnectorStatusLite[]>(
    "/api/bridge/connectors/status",
    {
      intervalMs: 60_000,
      transform: (raw) => {
        if (Array.isArray(raw)) return raw as ConnectorStatusLite[];
        const obj = raw as { connectors?: ConnectorStatusLite[] };
        return obj?.connectors ?? [];
      },
    },
  );
  const requiredConnectors = useMemo(() => {
    if (content.trim().length > 0) {
      return detectConnectorsFromYaml(content);
    }
    // Falls back to the name+description heuristic for the initial
    // moments before the buffer has loaded — keeps the strip from
    // flashing empty during the first paint.
    return detectConnectorsForRecipe({ name, description: "" });
  }, [content, name]);
  const connectorHealthMap = useMemo(() => {
    // Phase 1A.1 fix (Bug 2): bridge `/connections` returns
    // `healthy: null` for every connector — the dashboard's previous
    // `c.healthy` read was always undefined, painting all chips grey
    // AND causing `unhealthyConnectors` to fire the CTA even for
    // connected connectors. Switch to `status === "connected"` as the
    // positive signal — that field IS populated. `needs_reauth` and
    // `disconnected` both map to `false` (red dot, CTA fires).
    const m = new Map<string, boolean | undefined>();
    for (const c of connectorStatuses ?? []) {
      m.set(c.id, c.status === "connected");
    }
    return m;
  }, [connectorStatuses]);
  const unhealthyConnectors = useMemo(
    () =>
      requiredConnectors.filter(
        (id) => connectorHealthMap.get(id) !== true,
      ),
    [requiredConnectors, connectorHealthMap],
  );

  const lintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lintReqIdRef = useRef(0);
  // Step-anchor scroll target, derived from `window.location.hash` of the
  // form `#step-<id>`. Populated AFTER content loads so the line search
  // operates on real YAML. Stays set after navigation so the editor still
  // highlights even if the user types — the highlight only fires on
  // mount + when the value re-syncs, not on every keystroke.
  const [highlightStepId, setHighlightStepId] = useState<string | null>(null);
  const [highlightLine, setHighlightLine] = useState<number | undefined>(
    undefined,
  );
  // Mobile-fallback excerpt: when the viewport is too narrow for the
  // CodeMirror editor to be ergonomic, render a small read-only YAML
  // excerpt around the step so the user can still see what failed.
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    const check = () => setIsMobileViewport(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  // Read the hash once on mount; ignore subsequent in-app changes (no
  // hashchange listener — the editor view is the source of truth after
  // the initial land).
  useEffect(() => {
    const m = window.location.hash.match(/^#step-(.+)$/);
    if (m?.[1]) setHighlightStepId(decodeURIComponent(m[1]));
  }, []);
  // Once content loads + hash parsed, find the step's line by scanning
  // for `id: <stepId>` or `tool: <stepId>` (recipes use either style).
  // Match is best-effort; misses are silent.
  useEffect(() => {
    if (!highlightStepId || !content) {
      setHighlightLine(undefined);
      return;
    }
    const lines = content.split("\n");
    const escaped = highlightStepId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idRe = new RegExp(`^\\s*-?\\s*id:\\s*["']?${escaped}["']?\\s*$`);
    const toolRe = new RegExp(`^\\s*-?\\s*tool:\\s*["']?${escaped}["']?\\s*$`);
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      if (idRe.test(lines[i]!) || toolRe.test(lines[i]!)) {
        found = i + 1;
        break;
      }
    }
    setHighlightLine(found > 0 ? found : undefined);
  }, [highlightStepId, content]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}`),
        );
        if (res.ok) {
          const data = (await res.json()) as { content?: string } | string;
          const text =
            typeof data === "string"
              ? data
              : typeof data === "object" && data !== null && "content" in data
                ? (data.content ?? "")
                : "";
          if (!cancelled) {
            setContent(text);
            setSavedContent(text);
            setNotFound(false);
          }
        } else if (res.status === 404) {
          if (!cancelled) {
            setContent("");
            setSavedContent("");
            setNotFound(true);
          }
        } else {
          const err = await res.text().catch(() => "unknown error");
          if (!cancelled) toast.error(`Load failed: ${err}`);
        }
      } catch (e) {
        if (!cancelled)
          toast.error(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    // The new-recipe form stashes any save-time `warnings` in
    // sessionStorage so we can show them once on first paint here.
    // (The debounced lint pass below will re-derive its own list a few
    // hundred ms later — this just avoids a "saved successfully ✓"
    // moment that hides server-side feedback.)
    try {
      const key = `recipe-save-warnings:${name}`;
      const stashed = sessionStorage.getItem(key);
      if (stashed) {
        sessionStorage.removeItem(key);
        const parsed = JSON.parse(stashed) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          toast.info(
            `Saved with ${parsed.length} warning${parsed.length === 1 ? "" : "s"}: ${parsed
              .filter((w): w is string => typeof w === "string")
              .slice(0, 3)
              .join("; ")}${parsed.length > 3 ? "…" : ""}`,
          );
        }
      }
    } catch {
      // sessionStorage parse failure is benign — lint will re-derive.
    }
    return () => {
      cancelled = true;
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced live lint while editing — surfaces validateRecipeDefinition
  // warnings (e.g. dotted refs not in a tool's outputSchema) at edit time.
  useEffect(() => {
    if (loading) return;
    if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
    if (!content.trim()) {
      setLintErrors([]);
      setLintWarnings([]);
      setLintIssues([]);
      setLinting(false);
      return;
    }
    lintTimerRef.current = setTimeout(() => {
      const reqId = ++lintReqIdRef.current;
      setLinting(true);
      void fetch(apiPath("/api/bridge/recipes/lint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      })
        .then((res) => res.json().catch(() => ({}) as Record<string, unknown>))
        .then((data) => {
          if (reqId !== lintReqIdRef.current) return;
          // `/recipes/lint` returns LintIssue[] objects (level, message,
          // path?, code?). The page currently renders messages only; the
          // structured fields will be consumed by the CodeMirror linter
          // extension in Phase 1B.
          const toMessage = (raw: unknown): string | null => {
            if (typeof raw === "string") return raw; // legacy bridge
            if (
              raw &&
              typeof raw === "object" &&
              typeof (raw as { message?: unknown }).message === "string"
            ) {
              return (raw as { message: string }).message;
            }
            return null;
          };
          const errors = Array.isArray((data as { errors?: unknown }).errors)
            ? ((data as { errors: unknown[] }).errors
                .map(toMessage)
                .filter((m): m is string => m !== null))
            : [];
          const warnings = Array.isArray(
            (data as { warnings?: unknown }).warnings,
          )
            ? ((data as { warnings: unknown[] }).warnings
                .map(toMessage)
                .filter((m): m is string => m !== null))
            : [];
          setLintErrors(errors);
          setLintWarnings(warnings);
          // Phase 1B: collect structured issues (with line/column where
          // resolvable) to drive CodeMirror gutter diagnostics. Filters
          // raw items that lack the required `level` + `message` shape.
          const toIssue = (raw: unknown, level: "error" | "warning"): YamlLintIssue | null => {
            if (
              raw &&
              typeof raw === "object" &&
              typeof (raw as { message?: unknown }).message === "string"
            ) {
              const r = raw as Partial<YamlLintIssue>;
              return {
                level,
                message: r.message as string,
                ...(typeof r.line === "number" && { line: r.line }),
                ...(typeof r.column === "number" && { column: r.column }),
                ...(typeof r.code === "string" && { code: r.code }),
                ...(typeof r.path === "string" && { path: r.path }),
              };
            }
            return null;
          };
          const structuredErrors = Array.isArray(
            (data as { errors?: unknown }).errors,
          )
            ? (data as { errors: unknown[] }).errors
                .map((r) => toIssue(r, "error"))
                .filter((i): i is YamlLintIssue => i !== null)
            : [];
          const structuredWarnings = Array.isArray(
            (data as { warnings?: unknown }).warnings,
          )
            ? (data as { warnings: unknown[] }).warnings
                .map((r) => toIssue(r, "warning"))
                .filter((i): i is YamlLintIssue => i !== null)
            : [];
          setLintIssues([...structuredErrors, ...structuredWarnings]);
        })
        .catch(() => {
          // ignore lint failures; server may be unavailable
        })
        .finally(() => {
          if (reqId === lintReqIdRef.current) setLinting(false);
        });
    }, 400);
    return () => {
      if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
    };
  }, [content, loading]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      const warnings = Array.isArray((data as { warnings?: unknown }).warnings)
        ? ((data as { warnings: string[] }).warnings.filter(
            (w): w is string => typeof w === "string",
          ))
        : [];
      if (res.ok) {
        setLintWarnings(warnings);
        setLintErrors([]);
        setSavedContent(content);
        toast.success(
          warnings.length > 0
            ? `Saved with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
            : "Saved.",
        );
      } else {
        const message =
          (data as { error?: string }).error ?? res.statusText ?? "Save failed";
        setSaveError(message);
        setLintWarnings(warnings);
        toast.error(`Save failed: ${message}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
      toast.error(`Save failed: ${message}`);
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== savedContent;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Global Cmd/Ctrl+S to save when dirty — works even if textarea isn't focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (!saving && !loading && dirty) void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving, loading]);

  async function handleRun() {
    if (dirty) {
      const proceed = window.confirm(
        "You have unsaved changes. Run will execute the SAVED version, not your edits. Continue?",
      );
      if (!proceed) return;
    }
    setRunning(true);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}/run`),
        { method: "POST" },
      );
      if (res.ok) {
        const data = (await res.json()) as { taskId?: string; ok?: boolean };
        toast.success(
          data.taskId ? `Queued task ${data.taskId.slice(0, 8)}` : "Recipe started.",
        );
      } else {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        toast.error(
          `Run failed: ${(data as { error?: string }).error ?? res.statusText}`,
        );
      }
    } catch (e) {
      toast.error(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  async function handleFixWithAi() {
    if (repairBusy) return;
    setRepairBusy(true);
    try {
      const res = await fetch(apiPath("/api/bridge/recipes/repair"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentYaml: content, lintIssues }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        yaml?: string;
        warnings?: string[];
        error?: string;
        code?: string;
        unavailable?: boolean;
        retryAfterSeconds?: number;
      };
      if (res.status === 503 && data.code === "feature_disabled") {
        toast.info(
          "Recipe AI repair is off by default. Enable the `recipe.repair-ai` flag in Settings → Feature flags.",
        );
        return;
      }
      if (res.status === 503) {
        toast.error(
          "Recipe AI repair unavailable — needs `patchwork --driver subprocess` running.",
        );
        return;
      }
      if (res.status === 429) {
        toast.error(
          `Rate-limited. Try again in ${data.retryAfterSeconds ?? 60}s.`,
        );
        return;
      }
      if (!res.ok || !data.ok || !data.yaml) {
        toast.error(
          `AI repair failed: ${data.error ?? `HTTP ${res.status}`}`,
        );
        return;
      }
      setRepairProposal({
        yaml: data.yaml,
        warnings: data.warnings ?? [],
      });
    } catch (e) {
      toast.error(
        `AI repair request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setRepairBusy(false);
    }
  }

  function applyRepair() {
    if (!repairProposal) return;
    setContent(repairProposal.yaml);
    setRepairProposal(null);
    toast.success("Applied AI proposal. Review + save to commit.");
  }

  function discardRepair() {
    setRepairProposal(null);
  }

  return (
    <section>
      {/* The layout at recipes/[name]/layout.tsx already renders
          breadcrumb, H1, StatusPill, RelationStrip, and TabBar.
          Only edit-specific actions live here. */}
      <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", marginBottom: "var(--s-4)", flexWrap: "wrap" }}>
        {/* Mode toggle — segmented control */}
        <div
          role="group"
          aria-label="Edit mode"
          style={{
            display: "flex",
            borderRadius: "var(--r-2)",
            border: "1px solid var(--line-2)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {(["yaml", "form"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={editMode === mode}
              onClick={() => switchEditMode(mode)}
              style={{
                padding: "6px 14px",
                fontSize: "var(--fs-s)",
                fontWeight: editMode === mode ? 600 : 400,
                background: editMode === mode ? "var(--ink-0)" : "transparent",
                color: editMode === mode ? "var(--bg-0)" : "var(--ink-2)",
                border: "none",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s",
                minHeight: 32,
              }}
            >
              {mode === "yaml" ? "YAML" : "Form"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", marginLeft: "auto" }}>
          <Link
            href={`/recipes/${encodeURIComponent(name)}/plan`}
            className="btn"
          >
            Dry-run plan
          </Link>
          <button
            type="button"
            className="btn warn"
            onClick={() => void handleRun()}
            disabled={running || loading}
            title="Run the saved recipe immediately. May use API credits or call external services."
          >
            {running ? "Starting…" : "Run"}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={saving || loading || !dirty}
            title={!dirty && !saving ? "No unsaved changes" : undefined}
          >
            {saving ? "Saving…" : dirty ? "Save •" : "Save"}
          </button>
        </div>
      </div>

      {/* Recipe-not-found banner — fires when /api/bridge/recipes/:name 404'd
          on load. The editor still mounts (so the user can save and create the
          recipe) but without this banner the empty buffer looks like the
          recipe loaded blank. */}
      {!loading && notFound && (
        <div
          role="status"
          style={{
            marginBottom: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            borderRadius: "var(--r-2)",
            background: "var(--warn-soft)",
            border: "1px solid var(--warn)",
            color: "var(--warn)",
            fontSize: "var(--fs-m)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "var(--s-3)",
          }}
        >
          <div>
            <strong style={{ display: "block", marginBottom: 2 }}>
              Recipe not found
            </strong>
            <span style={{ fontSize: "var(--fs-s)" }}>
              No recipe named <code style={{ fontFamily: "var(--font-mono)" }}>{name}</code> exists yet. Saving here will create it as a new recipe.
            </span>
          </div>
          <Link
            href="/recipes/new"
            className="btn sm ghost"
            style={{ flexShrink: 0, fontSize: "var(--fs-xs)" }}
          >
            Use new-recipe form →
          </Link>
        </div>
      )}

      {/* Validation error banner */}
      {saveError && (
        <div
          role="alert"
          style={{
            marginBottom: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            borderRadius: "var(--r-2)",
            background: "var(--err-soft)",
            border: "1px solid var(--err)",
            color: "var(--err)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "var(--s-3)",
            fontSize: "var(--fs-m)",
          }}
        >
          <div>
            <strong style={{ display: "block", marginBottom: 2 }}>
              Save failed
            </strong>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}>
              {saveError}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            aria-label="Dismiss save error"
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "var(--fs-xl)",
              lineHeight: 1,
              padding: 0,
            }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Live lint errors banner */}
      {lintErrors.length > 0 && (
        <div
          role="alert"
          style={{
            marginBottom: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            borderRadius: "var(--r-2)",
            background: "var(--err-soft)",
            border: "1px solid var(--err)",
            color: "var(--err)",
            fontSize: "var(--fs-m)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--s-3)",
              marginBottom: 4,
            }}
          >
            <strong>
              {lintErrors.length} lint error
              {lintErrors.length === 1 ? "" : "s"}
            </strong>
            {/* Phase 2A.2: Fix with AI — posts to /recipes/repair (the
                bridge gates this behind the `recipe.repair-ai` flag;
                503 + feature_disabled → toast pointing at Settings). */}
            <button
              type="button"
              onClick={() => void handleFixWithAi()}
              disabled={repairBusy}
              className="btn sm"
              style={{ flexShrink: 0 }}
              aria-label="Propose an AI fix for the lint errors"
            >
              {repairBusy ? "Asking AI…" : "Fix with AI"}
            </button>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}>
            {lintErrors.map((msg, idx) => (
              <li key={`lint-err-${idx}`}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Phase 2A.2: AI repair preview modal. Renders the proposed
          YAML; user applies (overwrites editor content) or discards. */}
      {repairProposal !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="AI-proposed recipe fix"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "var(--s-4)",
          }}
          onClick={(e) => {
            // Backdrop click discards.
            if (e.target === e.currentTarget) discardRepair();
          }}
        >
          <div
            style={{
              background: "var(--bg-0)",
              borderRadius: "var(--r-3)",
              border: "1px solid var(--line-2)",
              maxWidth: 880,
              width: "100%",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-3)",
              padding: "var(--s-5)",
              overflow: "hidden",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: "var(--fs-l)" }}>
                AI proposed a fix
              </h2>
              <p
                style={{
                  margin: "var(--s-2) 0 0",
                  color: "var(--ink-2)",
                  fontSize: "var(--fs-s)",
                }}
              >
                Review the proposed YAML below. Apply will replace your
                editor content — save afterwards to commit. Discard
                throws this proposal away (your buffer is unchanged).
              </p>
            </div>
            {repairProposal.warnings.length > 0 && (
              <div
                style={{
                  background: "var(--warn-soft)",
                  border: "1px solid var(--warn)",
                  borderRadius: "var(--r-2)",
                  padding: "var(--s-2) var(--s-3)",
                  fontSize: "var(--fs-s)",
                  color: "var(--warn)",
                }}
              >
                <strong>
                  {repairProposal.warnings.length} warning
                  {repairProposal.warnings.length === 1 ? "" : "s"}:
                </strong>
                <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                  {repairProposal.warnings.map((w, idx) => (
                    <li key={`repair-warn-${idx}`}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <pre
              style={{
                flex: 1,
                overflow: "auto",
                background: "var(--recess)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-2)",
                padding: "var(--s-3)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-s)",
                color: "var(--ink-0)",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {repairProposal.yaml}
            </pre>
            <div
              style={{
                display: "flex",
                gap: "var(--s-3)",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="btn ghost"
                onClick={discardRepair}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={applyRepair}
              >
                Apply proposal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live lint warnings banner */}
      {lintWarnings.length > 0 && (
        <div
          role="status"
          style={{
            marginBottom: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            borderRadius: "var(--r-2)",
            background: "var(--warn-soft)",
            border: "1px solid var(--warn)",
            color: "var(--warn)",
            fontSize: "var(--fs-m)",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {lintWarnings.length} lint warning
            {lintWarnings.length === 1 ? "" : "s"}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}>
            {lintWarnings.map((msg, idx) => (
              <li key={`lint-warn-${idx}`}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Connectors required (Phase 1A item 5) — same chip strip as the
          overview page, surfaced here so authoring isn't blind to "this
          recipe needs Gmail and Gmail isn't connected". Clicking a chip
          deep-links to /connections#<id>. */}
      {requiredConnectors.length > 0 && (
        <div
          style={{
            marginBottom: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            borderRadius: "var(--r-2)",
            background: "var(--recess)",
            border: "1px solid var(--line-2)",
            fontSize: "var(--fs-m)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--s-2)",
              gap: "var(--s-3)",
            }}
          >
            <strong>Connectors required</strong>
            {unhealthyConnectors.length > 0 && (
              <Link
                href="/connections"
                style={{
                  fontSize: "var(--fs-s)",
                  color: "var(--info)",
                  textDecoration: "none",
                }}
              >
                Connect {unhealthyConnectors.length === 1 ? "it" : "them"} →
              </Link>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {requiredConnectors.map((id) => (
              <ConnectorChip
                key={id}
                id={id}
                healthy={connectorHealthMap.get(id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Editor card */}
      <div className="glass-card" style={{ padding: "var(--s-4)" }}>
        {/* Deep-link banner: surfaces when the user arrived from a
            failed-run "→ open in recipe YAML" link, regardless of
            whether the step was found. Distinguishes the three states:
            (a) step located + highlighted in editor; (b) step not
            found in current YAML (recipe may have been edited since
            the run); (c) mobile viewport where the editor is awkward. */}
        {highlightStepId && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginBottom: "var(--s-3)",
              padding: "10px 12px",
              borderRadius: "var(--r-2)",
              border: "1px solid var(--line-2)",
              background: "var(--bg-3)",
              fontSize: "var(--fs-s)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {highlightLine
                ? `Step \`${highlightStepId}\` highlighted at line ${highlightLine}.`
                : `Step \`${highlightStepId}\` not found in current YAML.`}
            </span>
            {isMobileViewport && (
              <span style={{ color: "var(--ink-2)" }}>
                YAML editor is best on a desktop browser — rotate to
                landscape or open this URL on a laptop.
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setHighlightStepId(null);
                setHighlightLine(undefined);
                // Strip the hash so the user doesn't keep landing here on reload.
                if (window.location.hash) {
                  history.replaceState(
                    null,
                    "",
                    window.location.pathname + window.location.search,
                  );
                }
              }}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--r-2)",
                padding: "6px 10px",
                fontSize: "var(--fs-xs)",
                cursor: "pointer",
                minHeight: 32,
              }}
              aria-label="Dismiss step highlight"
            >
              Dismiss
            </button>
          </div>
        )}
        {loading ? (
          <div className="empty-state">
            <p>Loading…</p>
          </div>
        ) : editMode === "form" ? (
          <RecipeFormSkeleton />
        ) : (
          <YamlEditor
            value={content}
            onChange={(v) => {
              setContent(v);
              if (saveError) setSaveError(null);
            }}
            onSave={() => void handleSave()}
            minHeight={400}
            highlightLine={highlightLine}
            lintIssues={lintIssues}
          />
        )}
        {editMode === "yaml" && (
          <div
            style={{
              marginTop: "var(--s-3)",
              fontSize: "var(--fs-s)",
              color: "var(--fg-3)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {content.split("\n").length} lines &middot; {content.length} chars
            </span>
            <span>
              {linting ? "Linting… " : ""}Tab inserts 2 spaces &middot; Cmd/Ctrl+S to save
            </span>
          </div>
        )}
      </div>

      {/* Mobile-only sticky save bar. The desktop Save button lives in
          the page header — fine on a 1400 px screen, but on a phone the
          editor is 2000+ px tall and the user has to scroll back to the
          top to save. Floating savebar at the bottom of the viewport
          mirrors the convention native iOS forms use. Hidden ≥769 px. */}
      <div className="recipe-editor-mobile-savebar" aria-hidden={false}>
        <button
          type="button"
          className="btn"
          onClick={() => void handleRun()}
          disabled={running || loading}
        >
          {running ? "Running…" : "Run"}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => void handleSave()}
          disabled={saving || loading || !dirty}
        >
          {saving ? "Saving…" : dirty ? "Save •" : "Save"}
        </button>
      </div>
    </section>
  );
}
