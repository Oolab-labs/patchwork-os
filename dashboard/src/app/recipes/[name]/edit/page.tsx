"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import { BackLink, RelationStrip } from "@/components/patchwork";
import { useToast } from "@/components/Toast";
import dynamic from "next/dynamic";

const YamlEditor = dynamic(() => import("./_components/YamlEditor"), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: 400, background: "var(--recess)", borderRadius: "var(--r-2)", border: "1px solid var(--line-2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
      Loading editor…
    </div>
  ),
});


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
  const [linting, setLinting] = useState(false);
  const toast = useToast();
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
          const errors = Array.isArray((data as { errors?: unknown }).errors)
            ? (data as { errors: string[] }).errors.filter(
                (m): m is string => typeof m === "string",
              )
            : [];
          const warnings = Array.isArray((data as { warnings?: unknown }).warnings)
            ? (data as { warnings: string[] }).warnings.filter(
                (m): m is string => typeof m === "string",
              )
            : [];
          setLintErrors(errors);
          setLintWarnings(warnings);
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

  return (
    <section>
      {/* Header */}
      <div className="page-head">
        <div>
          <BackLink href="/recipes" label="Recipes" />
          <h1 style={{ marginTop: 0 }}>
            Edit{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.85em",
                background: "var(--bg-2)",
                padding: "2px 8px",
                borderRadius: "var(--r-1)",
              }}
            >
              {name}
            </code>
          </h1>
          <div className="page-head-sub">Edit recipe YAML and save or run.</div>
          {/*
            "Feels connected" strip for the recipe detail. Lets users
            jump from editing the YAML straight to: the runs this
            recipe has produced (filtered by name), the live activity
            stream (where its events show up in real time), and the
            marketplace (to see published variants). Each chip is a
            link to a filtered list — the recipe detail used to dead-
            end into the editor with no outbound context.
          */}
          <RelationStrip
            items={[
              {
                label: "Recent runs",
                href: `/runs?recipe=${encodeURIComponent(name)}`,
                title: `Recent runs of ${name}`,
              },
              {
                label: "Halts",
                href: `/runs?recipe=${encodeURIComponent(name)}&halt=1`,
                tone: "warn",
                title: `Runs of ${name} that hit a halt reason`,
              },
              {
                label: "Traces",
                href: `/traces?recipe=${encodeURIComponent(name)}`,
                title: `Decision logs for ${name}`,
              },
              {
                label: "Live activity",
                href: "/activity",
                title: "Stream of every event from this and other recipes",
              },
              {
                label: "Marketplace",
                href: "/marketplace",
                title: "Community-published recipes",
              },
            ]}
          />
        </div>
        <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
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
          <strong style={{ display: "block", marginBottom: 4 }}>
            {lintErrors.length} lint error{lintErrors.length === 1 ? "" : "s"}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: "var(--fs-s)" }}>
            {lintErrors.map((msg, idx) => (
              <li key={`lint-err-${idx}`}>{msg}</li>
            ))}
          </ul>
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
          />
        )}
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
