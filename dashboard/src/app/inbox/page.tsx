"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from '@/lib/api';

type FilterCategory = "All" | "Morning Briefs" | "Recipe Outputs" | "Agent Reports";

// ------------------------------------------------------------------ types

interface InboxItem {
  name: string;
  path: string;
  modifiedAt: string;
  preview: string;
}

interface InboxDetail {
  name: string;
  content: string;
  modifiedAt: string;
}

// ------------------------------------------------------------------ slug helpers

function slugToTitle(name: string): string {
  // Remove .md extension, then remove trailing date suffix -YYYY-MM-DD
  const base = name.replace(/\.md$/, "");
  const withoutDate = base.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return withoutDate
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function slugToShortDate(name: string): string {
  const base = name.replace(/\.md$/, "");
  const m = base.match(/-(\d{4}-\d{2}-\d{2})$/);
  if (!m) return "";
  const d = new Date(m[1] + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function recipeIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("brief") || lower.includes("triage")) return "✉";
  if (lower.includes("health") || lower.includes("check")) return "🔍";
  return "📋";
}

// ------------------------------------------------------------------ preview strip

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")   // headings
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1")    // italic
    .replace(/^[-*]\s+/gm, "")     // list markers
    .replace(/_(.+?)_/g, "$1")     // underscores
    .replace(/`(.+?)`/g, "$1")     // inline code
    .replace(/\n+/g, " ")          // collapse newlines
    .trim();
}

// ------------------------------------------------------------------ markdown renderer

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(text: string): string {
  // Strip script/iframe tags and dangerous attributes first (security)
  let safe = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\s+on\w+="[^"]*"/gi, "")
    .replace(/href="javascript:[^"]*"/gi, 'href="#"');

  const lines = safe.split("\n");
  const html: string[] = [];
  let i = 0;
  let firstH1 = true;

  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      html.push(
        '<hr style="border:none;border-top:1px solid var(--border-default);margin:24px 0" />',
      );
      i++;
      continue;
    }

    // Headings
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) {
      html.push(
        `<h3 style="font-size:13px;font-weight:600;margin:16px 0 4px;color:var(--fg-1)">${escapeHtml(h3[1])}</h3>`,
      );
      i++;
      continue;
    }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) {
      html.push(
        `<h2 style="font-size:15px;font-weight:600;margin:24px 0 8px;color:var(--fg-0);padding-bottom:6px;border-bottom:1px solid var(--border-default)">${escapeHtml(h2[1])}</h2>`,
      );
      i++;
      continue;
    }
    const h1 = line.match(/^#\s+(.*)/);
    if (h1) {
      const marginTop = firstH1 ? "0" : "32px";
      firstH1 = false;
      html.push(
        `<h1 style="font-size:22px;font-weight:600;margin:${marginTop} 0 4px;color:var(--fg-0)">${escapeHtml(h1[1])}</h1>`,
      );
      i++;
      continue;
    }

    // Bullet list — collect consecutive list items
    if (/^[-*]\s+/.test(line)) {
      html.push(
        '<ul style="margin:6px 0 12px 0;padding-left:16px;list-style:disc">',
      );
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^[-*]\s+/, "");
        html.push(
          `<li style="font-size:13px;line-height:1.6;margin-bottom:6px;color:var(--fg-1)">${renderInline(item)}</li>`,
        );
        i++;
      }
      html.push("</ul>");
      continue;
    }

    // Empty line — paragraph break
    if (line.trim() === "") {
      html.push('<div style="height:8px"></div>');
      i++;
      continue;
    }

    // Paragraph
    html.push(
      `<p style="font-size:14px;line-height:1.7;margin:0 0 12px;color:var(--fg-1)">${renderInline(line)}</p>`,
    );
    i++;
  }

  return html.join("");
}

function renderInline(text: string): string {
  // Bold: **text**
  return escapeHtml(text).replace(
    /\*\*(.+?)\*\*/g,
    '<strong style="color:var(--fg-0)">$1</strong>',
  );
}

// ------------------------------------------------------------------ relative time

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ------------------------------------------------------------------ spinner

function Spinner() {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        width: 20,
        height: 20,
        border: "2px solid var(--border-default)",
        borderTopColor: "var(--fg-2)",
        borderRadius: "50%",
        animation: "inbox-spin 0.7s linear infinite",
      }}
    />
  );
}

// ------------------------------------------------------------------ page

const FILTER_CATEGORIES: FilterCategory[] = ["All", "Morning Briefs", "Recipe Outputs", "Agent Reports"];

function categoryForItem(name: string): Exclude<FilterCategory, "All"> {
  const lower = name.toLowerCase();
  if (lower.includes("morning-brief")) return "Morning Briefs";
  if (lower.includes("recipe") || lower.includes("ctx-loop") || lower.includes("sentry")) return "Recipe Outputs";
  return "Agent Reports";
}

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterCategory>("All");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const selectedRef = useRef<InboxDetail | null>(null);
  selectedRef.current = selected;

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(apiPath("/api/inbox"));
      if (!res.ok) throw new Error(`/api/inbox ${res.status}`);
      const data = (await res.json()) as { items: InboxItem[] };
      setItems(data.items ?? []);
      setErr(undefined);
      // Auto-refresh detail panel if the selected item was updated
      const cur = selectedRef.current;
      if (cur) {
        const updated = (data.items ?? []).find((i) => i.name === cur.name);
        if (updated && updated.modifiedAt !== cur.modifiedAt) {
          const detailRes = await fetch(apiPath(`/api/inbox/${encodeURIComponent(cur.name)}`));
          if (detailRes.ok) setSelected(await detailRes.json() as InboxDetail);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
    pollRef.current = setInterval(fetchList, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchList]);

  useEffect(() => {
    const container = detailRef.current;
    if (!container || !selected) return;

    const h2s = container.querySelectorAll<HTMLElement>("h2");
    const cleanup: (() => void)[] = [];

    for (const h2 of h2s) {
      if (h2.querySelector(".copy-section-btn")) continue;
      const btn = document.createElement("button");
      btn.className = "copy-section-btn";
      btn.type = "button";
      btn.textContent = "Copy";

      let next = h2.nextElementSibling;
      const parts: string[] = [];
      while (next && next.tagName !== "H2" && next.tagName !== "HR") {
        parts.push(next.textContent ?? "");
        next = next.nextElementSibling;
      }
      const sectionText = parts.join("\n").trim();

      const handler = () => {
        void navigator.clipboard.writeText(sectionText).then(() => {
          btn.textContent = "✓ Copied";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 2000);
        });
      };
      btn.addEventListener("click", handler);
      h2.appendChild(btn);
      cleanup.push(() => btn.removeEventListener("click", handler));
    }

    return () => {
      for (const fn of cleanup) fn();
      for (const h2 of h2s) {
        h2.querySelector(".copy-section-btn")?.remove();
      }
    };
  }, [selected]);

  const filteredItems =
    activeFilter === "All"
      ? items
      : items.filter((i) => categoryForItem(i.name) === activeFilter);

  async function selectItem(name: string) {
    if (selected?.name === name) {
      setSelected(null);
      return;
    }
    setDetailLoading(true);
    try {
      const res = await fetch(apiPath(`/api/inbox/${encodeURIComponent(name)}`));
      if (!res.ok) throw new Error(`/api/inbox/${name} ${res.status}`);
      const data = (await res.json()) as InboxDetail;
      setSelected(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <>
      <style>{`
        @keyframes inbox-spin {
          to { transform: rotate(360deg); }
        }
        .inbox-item:hover {
          background: var(--bg-2) !important;
        }
      `}</style>

      <section style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="page-head">
          <div>
            <h1>Inbox</h1>
            <div className="page-head-sub">
              Recipe outputs — briefs, summaries, and agent reports.
            </div>
          </div>
        </div>

        {err && (
          <div className="alert-err" role="alert" style={{ marginBottom: 16 }}>
            {err}
          </div>
        )}

        {loading ? (
          <div
            className="empty-state"
            role="status"
            aria-busy="true"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <Spinner />
            <span>Loading…</span>
          </div>
        ) : items.length === 0 ? (
          <div
            className="empty-state"
            role="status"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              flex: 1,
              minHeight: 200,
            }}
          >
            <div className="empty-state-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="M2 7l10 7 10-7"/>
              </svg>
            </div>
            <p style={{ color: "var(--fg-1)", fontSize: 15, fontWeight: 600, margin: 0 }}>
              No items yet
            </p>
            <p style={{ color: "var(--fg-3)", fontSize: 13, margin: 0 }}>
              Run a recipe to generate your first brief.
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flex: 1,
              minHeight: 0,
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-3)",
              overflow: "hidden",
              background: "var(--bg-1)",
            }}
          >
            {/* Left: item list */}
            <div
              style={{
                width: sidebarOpen ? 280 : 40,
                flexShrink: 0,
                borderRight: "1px solid var(--border-default)",
                overflowY: sidebarOpen ? "auto" : "hidden",
                display: "flex",
                flexDirection: "column",
                transition: "width 200ms ease",
              }}
            >
              {/* List header */}
              <div
                style={{
                  padding: "12px 8px 8px 16px",
                  borderBottom: "1px solid var(--border-subtle, var(--border-default))",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                {sidebarOpen && (
                  <>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--fg-3)",
                        flex: 1,
                      }}
                    >
                      Inbox
                    </span>
                    <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                      {filteredItems.length} {filteredItems.length === 1 ? "item" : "items"}
                    </span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setSidebarOpen((o) => !o)}
                  title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--fg-3)",
                    padding: "2px 4px",
                    borderRadius: 4,
                    fontSize: 12,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  {sidebarOpen ? "◀" : "▶"}
                </button>
              </div>

              {/* Filter chips */}
              {sidebarOpen && (
                <div className="filter-chips" style={{ padding: "8px 16px 0" }}>
                  {FILTER_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`filter-chip${activeFilter === cat ? " active" : ""}`}
                      onClick={() => setActiveFilter(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}

              {/* Items */}
              {sidebarOpen && filteredItems.map((item) => {
                const isActive = selected?.name === item.name;
                const title = slugToTitle(item.name);
                const shortDate = slugToShortDate(item.name);
                const icon = recipeIcon(item.name);
                const plainPreview = stripMarkdown(item.preview);

                return (
                  <button
                    key={item.name}
                    type="button"
                    className="inbox-item"
                    onClick={() => selectItem(item.name)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "14px 16px",
                      background: isActive
                        ? "rgba(184, 255, 87, 0.08)"
                        : "transparent",
                      borderLeft: isActive
                        ? "3px solid var(--ok)"
                        : "3px solid transparent",
                      borderTop: "none",
                      borderRight: "none",
                      borderBottom: "1px solid var(--border-subtle, var(--border-default))",
                      cursor: "pointer",
                      color: "var(--fg-0)",
                    }}
                    aria-pressed={isActive}
                  >
                    {/* Row 1: icon + title + short date */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontSize: 13, lineHeight: 1 }}>{icon}</span>
                      <span
                        style={{
                          flex: 1,
                          fontWeight: 600,
                          fontSize: 13,
                          color: "var(--fg-0)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {title}
                      </span>
                      {shortDate && (
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--fg-3)",
                            flexShrink: 0,
                          }}
                        >
                          {shortDate}
                        </span>
                      )}
                    </div>

                    {/* Row 2: plain preview */}
                    {plainPreview && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--fg-2)",
                          lineHeight: 1.5,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          marginBottom: 5,
                        }}
                      >
                        {plainPreview}
                      </div>
                    )}

                    {/* Row 3: relative timestamp */}
                    <div style={{ fontSize: 11, color: "var(--fg-3)" }}>
                      {relativeTime(item.modifiedAt)}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Right: content panel */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "32px 40px",
              }}
            >
              {detailLoading ? (
                <div
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                  role="status"
                  aria-busy="true"
                >
                  <Spinner />
                  <span style={{ fontSize: 13, color: "var(--fg-2)" }}>
                    Loading…
                  </span>
                </div>
              ) : selected ? (
                <div
                  style={{
                    maxWidth: 660,
                    fontSize: 14,
                    lineHeight: 1.7,
                    color: "var(--fg-1)",
                  }}
                >
                  {/* File metadata + close */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 11,
                      color: "var(--fg-3)",
                      marginBottom: 24,
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      {selected.name} &middot;{" "}
                      {new Date(selected.modifiedAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      title="Close"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--fg-3)",
                        fontSize: 16,
                        lineHeight: 1,
                        padding: "2px 4px",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {/* Rendered markdown */}
                  <div
                    ref={detailRef}
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(selected.content),
                    }}
                  />
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    gap: 8,
                    color: "var(--fg-3)",
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M2 7l10 7 10-7"/>
                  </svg>
                  <p style={{ fontSize: 14, color: "var(--fg-2)", margin: 0 }}>
                    Select an item to read it.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
