"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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
  const { toasts, push } = useToasts();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/bridge/recipes/${encodeURIComponent(name)}`,
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

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/bridge/recipes/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (res.ok) {
        push("Saved.", "ok");
      } else {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        push(
          `Save failed: ${(data as { error?: string }).error ?? res.statusText}`,
          "err",
        );
      }
    } catch (e) {
      push(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch(
        `/api/bridge/recipes/${encodeURIComponent(name)}/run`,
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
              background: t.kind === "ok" ? "var(--ok-soft, #1a3a2a)" : "var(--err-soft, #3a1a1a)",
              border: `1px solid ${t.kind === "ok" ? "var(--ok, #4ade80)" : "var(--err, #f87171)"}`,
              color: t.kind === "ok" ? "var(--ok, #4ade80)" : "var(--err, #f87171)",
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
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            aria-label={`YAML content for recipe ${name}`}
            style={{
              width: "100%",
              minHeight: 400,
              background: "#0f0f1a",
              color: "#e2e2f0",
              border: "1px solid var(--glass-border)",
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
              e.currentTarget.style.borderColor = "var(--glass-border)";
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
          <span>Tab inserts 2 spaces &middot; Cmd+S to save</span>
        </div>
      </div>
    </section>
  );
}
