"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";

interface Toast {
  id: number;
  message: string;
  kind: "ok" | "err";
}

let toastSeq = 0;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  function push(message: string, kind: Toast["kind"]) {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }

  return { toasts, push };
}

export default function RecipeEditPage({
  params,
}: {
  params: { name: string };
}) {
  const name = decodeURIComponent(params.name);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lintErrors, setLintErrors] = useState<string[]>([]);
  const [lintWarnings, setLintWarnings] = useState<string[]>([]);
  const [linting, setLinting] = useState(false);
  const { toasts, push } = useToasts();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lintReqIdRef = useRef(0);

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
          if (!cancelled) setContent(text);
        } else if (res.status === 404) {
          if (!cancelled) setContent("");
        } else {
          const err = await res.text().catch(() => "unknown error");
          if (!cancelled) push(`Load failed: ${err}`, "err");
        }
      } catch (e) {
        if (!cancelled)
          push(`Load failed: ${e instanceof Error ? e.message : String(e)}`, "err");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
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
        push(
          warnings.length > 0
            ? `Saved with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
            : "Saved.",
          "ok",
        );
      } else {
        const message =
          (data as { error?: string }).error ?? res.statusText ?? "Save failed";
        setSaveError(message);
        setLintWarnings(warnings);
        push(`Save failed: ${message}`, "err");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
      push(`Save failed: ${message}`, "err");
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch(
        apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}/run`),
        { method: "POST" },
      );
      if (res.ok) {
        const data = (await res.json()) as { taskId?: string; ok?: boolean };
        push(
          data.taskId ? `Queued task ${data.taskId.slice(0, 8)}` : "Recipe started.",
          "ok",
        );
      } else {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        push(
          `Run failed: ${(data as { error?: string }).error ?? res.statusText}`,
          "err",
        );
      }
    } catch (e) {
      push(`Run failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section>
      {/* Toast container */}
      <div
        style={{
          position: "fixed",
          bottom: "var(--s-6)",
          right: "var(--s-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-2)",
          zIndex: 9000,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pill ${t.kind === "ok" ? "ok" : "err"}`}
            style={{
              padding: "var(--s-2) var(--s-4)",
              fontSize: 13,
              borderRadius: "var(--r-2)",
              background: t.kind === "ok" ? "var(--ok-soft)" : "var(--err-soft)",
              border: `1px solid ${t.kind === "ok" ? "var(--ok)" : "var(--err)"}`,
              color: t.kind === "ok" ? "var(--ok)" : "var(--err)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              pointerEvents: "auto",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="page-head">
        <div>
          <div style={{ marginBottom: "var(--s-1)" }}>
            <Link
              href="/recipes"
              style={{
                color: "var(--fg-3)",
                fontSize: 13,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              &#8592; Recipes
            </Link>
          </div>
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
            className="btn"
            onClick={() => void handleRun()}
            disabled={running || loading}
          >
            {running ? "Starting…" : "Run"}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={saving || loading}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

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
            fontSize: 13,
          }}
        >
          <div>
            <strong style={{ display: "block", marginBottom: 2 }}>
              Save failed
            </strong>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
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
              fontSize: 16,
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
            fontSize: 13,
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {lintErrors.length} lint error{lintErrors.length === 1 ? "" : "s"}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: 12 }}>
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
            fontSize: 13,
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {lintWarnings.length} lint warning
            {lintWarnings.length === 1 ? "" : "s"}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            {lintWarnings.map((msg, idx) => (
              <li key={`lint-warn-${idx}`}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Editor card */}
      <div className="glass-card" style={{ padding: "var(--s-4)" }}>
        {loading ? (
          <div className="empty-state">
            <p>Loading…</p>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              if (saveError) setSaveError(null);
            }}
            spellCheck={false}
            aria-label={`YAML content for recipe ${name}`}
            style={{
              width: "100%",
              minHeight: 400,
              background: "var(--recess)",
              color: "var(--ink-0)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)",
              fontSize: 13,
              lineHeight: 1.6,
              padding: "var(--s-4)",
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
              tabSize: 2,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--accent)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--line-2)";
            }}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                const ta = e.currentTarget;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                const newContent =
                  content.substring(0, start) + "  " + content.substring(end);
                setContent(newContent);
                requestAnimationFrame(() => {
                  ta.selectionStart = start + 2;
                  ta.selectionEnd = start + 2;
                });
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                void handleSave();
              }
            }}
          />
        )}
        <div
          style={{
            marginTop: "var(--s-3)",
            fontSize: 12,
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
    </section>
  );
}
