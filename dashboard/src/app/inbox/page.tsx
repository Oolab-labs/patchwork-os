"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";

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

function RecipeIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (lower.includes("brief") || lower.includes("triage"))
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M2 7l10 7 10-7" />
      </svg>
    );
  if (lower.includes("health") || lower.includes("check"))
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
    );
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

function senderBadgeColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("morning-brief")) return "var(--orange)";
  if (lower.includes("health") || lower.includes("check")) return "var(--ok, #0d8a5e)";
  if (lower.includes("sentry") || lower.includes("error") || lower.includes("incident")) return "var(--err, #b91c1c)";
  if (lower.includes("recipe") || lower.includes("ctx-loop")) return "#6b6bff";
  return "var(--ink-2)";
}

// ------------------------------------------------------------------ preview strip

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n+/g, " ")
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

function renderInline(text: string): string {
  return escapeHtml(text).replace(
    /\*\*(.+?)\*\*/g,
    '<strong style="color:var(--fg-0)">$1</strong>',
  );
}

function renderMarkdown(text: string): string {
  let safe = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/(href|src)\s*=\s*["']?\s*data:[^"'\s>]*["']?/gi, '$1="#"')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*["']?/gi, 'href="#"');

  const lines = safe.split("\n");
  const html: string[] = [];
  let i = 0;
  let firstH1 = true;

  while (i < lines.length) {
    const line = lines[i];

    if (/^---+\s*$/.test(line)) {
      html.push('<hr style="border:none;border-top:1px solid var(--line-2);margin:20px 0" />');
      i++;
      continue;
    }

    const h3 = line.match(/^###\s+(.*)/);
    if (h3) {
      html.push(`<h3 style="font-size:12px;font-weight:700;margin:16px 0 4px;color:var(--ink-3);letter-spacing:0.06em;text-transform:uppercase">${escapeHtml(h3[1])}</h3>`);
      i++;
      continue;
    }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) {
      html.push(`<h2 style="font-size:15px;font-weight:600;margin:24px 0 8px;color:var(--ink-0);padding-bottom:6px;border-bottom:1px solid var(--line-2)">${escapeHtml(h2[1])}</h2>`);
      i++;
      continue;
    }
    const h1 = line.match(/^#\s+(.*)/);
    if (h1) {
      const marginTop = firstH1 ? "0" : "32px";
      firstH1 = false;
      html.push(`<h1 style="font-size:21px;font-weight:700;margin:${marginTop} 0 4px;color:var(--ink-0)">${escapeHtml(h1[1])}</h1>`);
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      html.push('<ul style="margin:4px 0 12px 0;padding-left:16px;list-style:disc">');
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^[-*]\s+/, "");
        html.push(`<li style="font-size:13.5px;line-height:1.65;margin-bottom:4px;color:var(--ink-1)">${renderInline(item)}</li>`);
        i++;
      }
      html.push("</ul>");
      continue;
    }

    if (line.trim() === "") {
      html.push('<div style="height:6px"></div>');
      i++;
      continue;
    }

    html.push(`<p style="font-size:14px;line-height:1.75;margin:0 0 10px;color:var(--ink-1)">${renderInline(line)}</p>`);
    i++;
  }

  return html.join("");
}

// ------------------------------------------------------------------ relative time (live)

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

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------ spinner

function Spinner({ size = 18 }: { size?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        width: size,
        height: size,
        border: "2px solid var(--line-2)",
        borderTopColor: "var(--ink-2)",
        borderRadius: "50%",
        animation: "inbox-spin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

// ------------------------------------------------------------------ category

const FILTER_CATEGORIES: FilterCategory[] = ["All", "Morning Briefs", "Recipe Outputs", "Agent Reports"];

function categoryForItem(name: string): Exclude<FilterCategory, "All"> {
  const lower = name.toLowerCase();
  if (lower.includes("morning-brief")) return "Morning Briefs";
  if (lower.includes("recipe") || lower.includes("ctx-loop") || lower.includes("sentry")) return "Recipe Outputs";
  return "Agent Reports";
}

// ------------------------------------------------------------------ page

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterCategory>("All");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [seenNames] = useState<Set<string>>(() => new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<InboxDetail | null>(null);
  selectedRef.current = selected;
  const now = useNow(60_000);

  const fetchList = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await fetch(apiPath("/api/inbox"));
      if (!res.ok) throw new Error(`/api/inbox ${res.status}`);
      const data = (await res.json()) as { items: InboxItem[] };
      const incoming = data.items ?? [];
      setItems((prev) => {
        if (prev.length === 0) {
          // First load — seed seenNames so existing items don't show "new" badge
          for (const item of incoming) {
            seenNames.add(item.name);
          }
        }
        // Items added after first load will not be in seenNames → show "new" badge
        // Badge clears only when user clicks item (selectItem)
        return incoming;
      });
      setErr(undefined);
      // Auto-refresh detail if modified upstream
      const cur = selectedRef.current;
      if (cur) {
        const updated = incoming.find((i) => i.name === cur.name);
        if (updated && updated.modifiedAt !== cur.modifiedAt) {
          const detailRes = await fetch(apiPath(`/api/inbox/${encodeURIComponent(cur.name)}`));
          if (detailRes.ok) setSelected((await detailRes.json()) as InboxDetail);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, [seenNames]);

  useEffect(() => {
    fetchList();
    pollRef.current = setInterval(() => fetchList(), 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchList]);

  // Copy buttons on h2 headings
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
          btn.textContent = "Copied ✓";
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
      for (const h2 of h2s) h2.querySelector(".copy-section-btn")?.remove();
    };
  }, [selected]);

  const filteredItems = items.filter((item) => {
    if (activeFilter !== "All" && categoryForItem(item.name) !== activeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.preview.toLowerCase().includes(q) ||
        slugToTitle(item.name).toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Mark item as seen when selected
  async function selectItem(name: string) {
    if (selected?.name === name) {
      setSelected(null);
      return;
    }
    seenNames.add(name);
    setDetailLoading(true);
    try {
      const res = await fetch(apiPath(`/api/inbox/${encodeURIComponent(name)}`));
      if (!res.ok) throw new Error(`/api/inbox/${name} ${res.status}`);
      setSelected((await res.json()) as InboxDetail);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }

  const unseen = items.filter((i) => !seenNames.has(i.name)).length;

  return (
    <>
      <style>{`
        @keyframes inbox-spin { to { transform: rotate(360deg); } }
        .inbox-item:hover { background: var(--recess) !important; }
        .inbox-item-active { background: rgba(99,102,241,0.07) !important; border-left-color: var(--accent) !important; }
        .copy-section-btn {
          margin-left: 10px;
          padding: 2px 8px;
          font-size: 10px;
          font-weight: 600;
          border-radius: var(--r-full);
          border: 1px solid var(--line-2);
          background: var(--recess);
          color: var(--ink-3);
          cursor: pointer;
          vertical-align: middle;
          transition: background 120ms, color 120ms;
        }
        .copy-section-btn:hover { background: var(--surface); color: var(--ink-1); }
        .copy-section-btn.copied { background: var(--green-soft); color: var(--green); border-color: transparent; }
      `}</style>

      <section style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", minHeight: 500 }}>
        {/* Page header */}
        <div className="page-head" style={{ marginBottom: 16 }}>
          <div>
            <h1>Inbox</h1>
            <div className="page-head-sub">Recipe outputs — briefs, summaries, and agent reports.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {unseen > 0 && (
              <span className="pill info" style={{ fontSize: 11 }}>
                {unseen} new
              </span>
            )}
            <span className="pill muted" style={{ fontSize: 11 }}>
              {items.length} item{items.length !== 1 ? "s" : ""}
            </span>
            <button
              type="button"
              onClick={() => fetchList(true)}
              disabled={refreshing}
              title="Refresh"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 12px",
                borderRadius: "var(--r-full)",
                border: "1px solid var(--line-2)",
                background: "transparent",
                color: "var(--ink-2)",
                fontSize: 12,
                fontWeight: 600,
                cursor: refreshing ? "default" : "pointer",
                opacity: refreshing ? 0.6 : 1,
                transition: "opacity 150ms",
              }}
            >
              {refreshing ? (
                <Spinner size={12} />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              )}
              Refresh
            </button>
          </div>
        </div>

        {err && (
          <div className="alert-err" role="alert" style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span>{err}</span>
            <button
              type="button"
              onClick={() => fetchList(true)}
              style={{ fontSize: 11, fontWeight: 600, color: "inherit", background: "none", border: "1px solid currentColor", borderRadius: "var(--r-full)", padding: "2px 10px", cursor: "pointer", opacity: 0.8, flexShrink: 0 }}
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="empty-state" role="status" aria-busy="true" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Spinner />
            <span>Loading…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state" role="status" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, flex: 1, minHeight: 200 }}>
            <div className="empty-state-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="M2 7l10 7 10-7"/>
              </svg>
            </div>
            <p style={{ color: "var(--ink-1)", fontSize: 15, fontWeight: 600, margin: 0 }}>No items yet</p>
            <p style={{ color: "var(--ink-3)", fontSize: 13, margin: 0 }}>Run a recipe to generate your first brief.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flex: 1, minHeight: 0, border: "1px solid var(--line-1)", borderRadius: "var(--r-l)", overflow: "hidden", background: "var(--surface)" }}>

            {/* ── Left sidebar ── */}
            <div style={{ width: sidebarOpen ? 300 : 48, flexShrink: 0, borderRight: "1px solid var(--line-1)", display: "flex", flexDirection: "column", transition: "width 200ms ease", overflow: "hidden" }}>

              {/* Sidebar header */}
              <div style={{ padding: "10px 10px 10px 14px", borderBottom: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {sidebarOpen ? (
                  <>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-3)", flex: 1 }}>
                      Messages
                    </span>
                    {unseen > 0 && (
                      <span className="pill info" style={{ fontSize: 10, padding: "2px 7px" }}>{unseen} new</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSidebarOpen(false)}
                      title="Collapse"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: "3px 5px", borderRadius: "var(--r-s)", fontSize: 11, lineHeight: 1 }}
                    >
                      ◀
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    title="Expand"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: "3px 5px", borderRadius: "var(--r-s)", fontSize: 11, lineHeight: 1, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="4" width="20" height="16" rx="2"/>
                      <path d="M2 7l10 7 10-7"/>
                    </svg>
                    {unseen > 0 && (
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", display: "block" }} />
                    )}
                  </button>
                )}
              </div>

              {sidebarOpen && (
                <>
                  {/* Search */}
                  <div style={{ padding: "10px 12px 8px" }}>
                    <input
                      type="search"
                      className="input"
                      placeholder="Search…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="Search inbox"
                      style={{ width: "100%", fontSize: 12 }}
                    />
                  </div>

                  {/* Category filter chips */}
                  <div style={{ padding: "0 12px 8px", display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {FILTER_CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setActiveFilter(cat)}
                        style={{
                          padding: "3px 10px",
                          borderRadius: "var(--r-full)",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                          border: "1px solid",
                          borderColor: activeFilter === cat ? "var(--accent)" : "var(--line-2)",
                          background: activeFilter === cat ? "var(--accent-soft)" : "transparent",
                          color: activeFilter === cat ? "var(--accent-strong)" : "var(--ink-3)",
                          transition: "all 120ms",
                          whiteSpace: "nowrap",
                        }}
                        aria-pressed={activeFilter === cat}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>

                  {/* Item list */}
                  <div style={{ overflowY: "auto", flex: 1 }}>
                    {filteredItems.length === 0 ? (
                      <div style={{ padding: "20px 16px", textAlign: "center", color: "var(--ink-3)", fontSize: 12 }}>
                        No items match
                      </div>
                    ) : (
                      filteredItems.map((item) => {
                        const isActive = selected?.name === item.name;
                        const isNew = !seenNames.has(item.name);
                        const title = slugToTitle(item.name);
                        const shortDate = slugToShortDate(item.name);
                        const plainPreview = stripMarkdown(item.preview);
                        // suppress unused now dep — just referencing it forces re-render for live timestamps
                        void now;

                        return (
                          <button
                            key={item.name}
                            type="button"
                            className={`inbox-item${isActive ? " inbox-item-active" : ""}`}
                            onClick={() => selectItem(item.name)}
                            style={{
                              display: "block",
                              width: "100%",
                              textAlign: "left",
                              padding: "11px 14px",
                              background: isActive ? undefined : "transparent",
                              borderLeft: `3px solid ${isActive ? "var(--accent)" : isNew ? "var(--orange)" : "transparent"}`,
                              borderTop: "none",
                              borderRight: "none",
                              borderBottom: "1px solid var(--line-1)",
                              cursor: "pointer",
                              color: "var(--fg-0)",
                            }}
                            aria-pressed={isActive}
                          >
                            {/* Row 1: icon + title + date */}
                            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                              <span style={{ color: senderBadgeColor(item.name), lineHeight: 1, flexShrink: 0 }}>
                                <RecipeIcon name={item.name} />
                              </span>
                              <span style={{ flex: 1, fontWeight: isNew ? 700 : 500, fontSize: 13, color: "var(--ink-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {title}
                              </span>
                              {shortDate && (
                                <span style={{ fontSize: 10, color: "var(--ink-3)", flexShrink: 0 }}>{shortDate}</span>
                              )}
                            </div>

                            {/* Row 2: preview */}
                            {plainPreview && (
                              <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 }}>
                                {plainPreview}
                              </div>
                            )}

                            {/* Row 3: timestamp + new badge */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                                {relativeTime(item.modifiedAt)}
                              </span>
                              {isNew && (
                                <span className="pill info" style={{ fontSize: 9, padding: "1px 6px" }}>new</span>
                              )}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── Right content panel ── */}
            <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
              {detailLoading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "40px 40px" }} role="status" aria-busy="true">
                  <Spinner />
                  <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Loading…</span>
                </div>
              ) : selected ? (
                <div style={{ padding: "28px 40px 48px", maxWidth: 700 }}>
                  {/* Detail header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, paddingBottom: 14, borderBottom: "1px solid var(--line-1)" }}>
                    <span style={{ color: senderBadgeColor(selected.name), lineHeight: 1, flexShrink: 0 }}>
                      <RecipeIcon name={selected.name} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {slugToTitle(selected.name)}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                        {new Date(selected.modifiedAt).toLocaleString()} &middot; <span style={{ fontFamily: "var(--font-mono)" }}>{selected.name}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      title="Close"
                      aria-label="Close detail"
                      style={{ background: "none", border: "1px solid var(--line-2)", cursor: "pointer", color: "var(--ink-3)", fontSize: 13, lineHeight: 1, padding: "4px 8px", borderRadius: "var(--r-s)", flexShrink: 0, transition: "background 120ms" }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Rendered content */}
                  <div
                    ref={detailRef}
                    style={{ fontSize: 14, lineHeight: 1.7, color: "var(--ink-1)" }}
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(selected.content) }}
                  />
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-3)" }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M2 7l10 7 10-7"/>
                  </svg>
                  <p style={{ fontSize: 13, color: "var(--ink-2)", margin: 0, fontWeight: 500 }}>
                    Select a message to read it
                  </p>
                  {filteredItems.length > 0 && (
                    <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                      {filteredItems.length} message{filteredItems.length !== 1 ? "s" : ""} in this view
                    </p>
                  )}
                </div>
              )}
            </div>

          </div>
        )}
      </section>
    </>
  );
}
