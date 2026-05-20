"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { apiPath } from "@/lib/api";
import { EmptyState, HintCard } from "@/components/patchwork";
import { InboxDeliveryCard } from "@/components/InboxDeliveryCard";
import { useToast } from "@/components/Toast";
import { useSearchHotkey } from "@/hooks/useSearchHotkey";

function isFilterCategory(v: string | null): v is FilterCategory {
  return v === "All" || v === "Morning Briefs" || v === "Recipe Outputs" || v === "Agent Reports";
}

// react-markdown + its rehype/remark plugins ship ~80KB gzipped of
// mdast/hast/micromark machinery. They're only needed to render the
// currently-selected message body — split into a lazy chunk so the
// inbox list view loads without them.
const MessageMarkdown = dynamic(() => import("@/components/MessageMarkdown"), {
  ssr: false,
  loading: () => <div aria-busy="true" />,
});

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
  if (lower.includes("health") || lower.includes("check")) return "var(--ok)";
  if (lower.includes("sentry") || lower.includes("error") || lower.includes("incident")) return "var(--err)";
  if (lower.includes("recipe") || lower.includes("ctx-loop")) return "var(--purple)";
  return "var(--ink-2)";
}

// Gmail-style avatar: colored circle with an initial. Color is derived
// deterministically from the source name so each recipe gets a stable hue.
function avatarInitial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

function SenderAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const title = slugToTitle(name);
  const bg = senderBadgeColor(name);
  return (
    <span
      aria-hidden="true"
      className="inbox-avatar"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {avatarInitial(title)}
    </span>
  );
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

/**
 * Inbox markdown renderer.
 *
 * Source: local agent-output files at `~/.patchwork/inbox/*.md`. The
 * dashboard's API route reads them server-side and the path-traversal
 * guard there is the trust boundary against external content. We do
 * NOT trust the markdown to be free of HTML — agents or recipes can
 * write whatever they want — so we render through `react-markdown` +
 * `rehype-sanitize` (default safelist) instead of the prior hand-rolled
 * regex stripper. The default rehype-sanitize schema drops `<script>`,
 * `<iframe>`, `on*` attributes, `javascript:`/`data:` URLs, etc.
 *
 * Per-element styles preserved as CSS overrides via `components` so the
 * existing dashboard look/feel is retained without inline `style="…"`
 * attributes embedded in HTML strings (which sanitize-allows-style would
 * otherwise need to permit).
 */
// React-controlled section heading with a Copy button. Replaces the prior
// post-render DOM injection (querySelectorAll('h2') + appendChild) with a
// component that owns its own state and lifecycle. On click it walks
// subsequent DOM siblings until the next h2/hr to gather the section text —
// that walk is unavoidable because react-markdown only sees this h2's own
// children, not the content that follows it in the rendered tree.
function H2WithCopy({ children }: { children?: React.ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const el = headingRef.current;
    if (!el) return;
    const parts: string[] = [];
    let next = el.nextElementSibling;
    while (next && next.tagName !== "H2" && next.tagName !== "HR") {
      parts.push(next.textContent ?? "");
      next = next.nextElementSibling;
    }
    const text = parts.join("\n").trim();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  }, []);
  return (
    <h2
      ref={headingRef}
      style={{
        fontSize: "var(--fs-l)",
        fontWeight: 600,
        margin: "24px 0 8px",
        color: "var(--ink-0)",
        paddingBottom: 6,
        borderBottom: "1px solid var(--line-2)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Section copied to clipboard" : "Copy section to clipboard"}
        className={`copy-section-btn${copied ? " copied" : ""}`}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </h2>
  );
}

const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1
      style={{
        fontSize: 21,
        fontWeight: 700,
        margin: "0 0 4px",
        color: "var(--ink-0)",
      }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => <H2WithCopy>{children}</H2WithCopy>,
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3
      style={{
        fontSize: "var(--fs-s)",
        fontWeight: 700,
        margin: "16px 0 4px",
        color: "var(--ink-3)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p
      style={{
        fontSize: "var(--fs-base)",
        lineHeight: 1.75,
        margin: "0 0 10px",
        color: "var(--ink-1)",
      }}
    >
      {children}
    </p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul
      style={{
        margin: "4px 0 12px 0",
        paddingLeft: 16,
        listStyle: "disc",
      }}
    >
      {children}
    </ul>
  ),
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid var(--line-2)",
        margin: "20px 0",
      }}
    />
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong style={{ color: "var(--fg-0)" }}>{children}</strong>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li
      style={{
        fontSize: 13.5,
        lineHeight: 1.65,
        marginBottom: 4,
        color: "var(--ink-1)",
        overflowWrap: "break-word",
        wordBreak: "break-word",
      }}
    >
      {children}
    </li>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre
      style={{
        background: "var(--recess)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--r-s)",
        padding: "10px 14px",
        margin: "8px 0 12px",
        fontSize: "var(--fs-xs)",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.6,
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {children}
    </pre>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = !!className;
    return isBlock ? (
      <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>{children}</code>
    ) : (
      <code
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.875em",
          background: "var(--recess)",
          border: "1px solid var(--line-1)",
          borderRadius: 4,
          padding: "1px 5px",
          wordBreak: "break-all",
        }}
      >
        {children}
      </code>
    );
  },
};

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

function RelativeTime({ iso }: { iso: string }) {
  const now = useNow(60_000);
  // Reference now so the linter knows it drives the render.
  void now;
  return <>{relativeTime(iso)}</>;
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
  const searchInputRef = useSearchHotkey();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filterFromUrl = searchParams?.get("filter");
  const [activeFilter, setActiveFilterState] = useState<FilterCategory>(
    isFilterCategory(filterFromUrl) ? filterFromUrl : "All",
  );
  const setActiveFilter = (next: FilterCategory) => {
    setActiveFilterState(next);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "All") params.delete("filter");
    else params.set("filter", next);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [seenNames] = useState<Set<string>>(() => new Set());
  const toast = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<InboxDetail | null>(null);
  selectedRef.current = selected;
  // #600: track in-flight list fetch so we can abort on unmount /
  // visibilitychange. Previously the response could land after the
  // user navigated away → setItems() on a dead tree.
  const listAbortRef = useRef<AbortController | null>(null);

  const fetchList = useCallback(async (manual = false) => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    if (manual) setRefreshing(true);
    try {
      const res = await fetch(apiPath("/api/inbox"), { signal: controller.signal });
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
          const detailRes = await fetch(
            apiPath(`/api/inbox/${encodeURIComponent(cur.name)}`),
            { signal: controller.signal },
          );
          if (detailRes.ok) setSelected((await detailRes.json()) as InboxDetail);
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (listAbortRef.current === controller) {
        setLoading(false);
        if (manual) setRefreshing(false);
        listAbortRef.current = null;
      }
    }
  }, [seenNames]);

  useEffect(() => {
    fetchList();
    pollRef.current = setInterval(() => fetchList(), 30_000);
    const onVisible = () => {
      if (document.hidden) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      } else if (!pollRef.current) {
        void fetchList();
        pollRef.current = setInterval(() => fetchList(), 30_000);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      // #600: abort any in-flight list fetch on unmount.
      listAbortRef.current?.abort();
    };
  }, [fetchList]);

  // Auto-select first item after initial load if nothing is selected
  useEffect(() => {
    if (!loading && items.length > 0 && !selected && !detailLoading) {
      void selectItem(items[0].name);
    }
    // Only on initial load — don't re-trigger on polling updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

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
      // Move focus to the detail pane so keyboard users skip past the
      // sidebar nav. Pane has tabIndex={-1} so it's programmatically
      // focusable but stays out of the natural Tab order afterwards.
      requestAnimationFrame(() => {
        detailRef.current?.focus({ preventScroll: false });
      });
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

      <section style={{ display: "flex", flexDirection: "column", height: "calc(100dvh - 120px)", minHeight: 500 }}>
        {/* Page header */}
        <div className="page-head" style={{ marginBottom: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 className="editorial-h1" style={{ margin: 0 }}>
                Inbox — <span className="accent">what your agents wrote you.</span>
              </h1>
              <HintCard.Toggle id="inbox" />
            </div>
            <div className="editorial-sub">~/.patchwork/inbox · briefs · summaries · agent reports</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {unseen > 0 && (
              <span className="pill info" style={{ fontSize: "var(--fs-xs)" }}>
                {unseen} new
              </span>
            )}
            <span className="pill muted" style={{ fontSize: "var(--fs-xs)" }}>
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
                justifyContent: "center",
                gap: 5,
                // 32px min hit target meets WCAG 2.5.5 (24×24); 9px vertical
                // padding around the 12px icon lands at exactly 32 + border.
                padding: "9px 14px",
                minHeight: 32,
                borderRadius: "var(--r-full)",
                border: "1px solid var(--line-2)",
                background: "transparent",
                color: "var(--ink-2)",
                fontSize: "var(--fs-s)",
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

        <HintCard id="inbox" />

        {/*
          Discovery card for the "deliver to phone" capability. Lives
          above the items list so it surfaces to every user who hasn't
          dismissed it — the people who already use /inbox in a browser
          are exactly the audience for "stop coming here, get pushed".
        */}
        <InboxDeliveryCard />

        {err && (
          <div className="alert-err" role="alert" style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span>{err}</span>
            <button
              type="button"
              onClick={() => fetchList(true)}
              style={{ fontSize: "var(--fs-xs)", fontWeight: 600, color: "inherit", background: "none", border: "1px solid currentColor", borderRadius: "var(--r-full)", padding: "2px 10px", cursor: "pointer", opacity: 0.8, flexShrink: 0 }}
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
        ) : items.length === 0 && !err ? (
          // Suppress "Run a recipe to generate your first brief" when err
          // is set — the cause of the empty list is connectivity / fetch
          // failure, not an actual empty inbox. The alert-err above this
          // block already explains the failure and offers Retry, so a
          // second misleading CTA below just creates noise.
          <EmptyState
            icon={
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M2 7l10 7 10-7" />
              </svg>
            }
            title="No items yet"
            description={
              <>
                Run a recipe to generate your first brief.
                {/*
                  Empty-state variant of the delivery card — reframes "no
                  items here" as "set up phone delivery so you don't have
                  to come back". Single-line, no dismissal needed.
                */}
                <div>
                  <InboxDeliveryCard variant="empty" />
                </div>
              </>
            }
          />
        ) : items.length === 0 && err ? null : (
          <div
            className={`inbox-twopane${selected ? " inbox-twopane--reader" : " inbox-twopane--list"}`}
            style={{ display: "flex", flex: 1, minHeight: 0, border: "1px solid var(--line-1)", borderRadius: "var(--r-l)", overflow: "hidden", background: "var(--surface)" }}
          >

            {/* ── Left sidebar (list) ── */}
            <div
              className="inbox-list-pane"
              style={{ width: sidebarOpen ? 300 : 48, flexShrink: 0, borderRight: "1px solid var(--line-1)", display: "flex", flexDirection: "column", transition: "width 200ms ease", overflow: "hidden" }}
            >

              {/* Sidebar header */}
              <div className="inbox-sidebar-header" style={{ padding: "10px 10px 10px 14px", borderBottom: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {sidebarOpen ? (
                  <>
                    <span style={{ fontSize: "var(--fs-xs)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-3)", flex: 1 }}>
                      Messages
                    </span>
                    {unseen > 0 && (
                      <span className="pill info" style={{ fontSize: "var(--fs-2xs)", padding: "2px 7px" }}>{unseen} new</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSidebarOpen(false)}
                      title="Collapse sidebar"
                      aria-label="Collapse message sidebar"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: "8px 10px", minWidth: 32, minHeight: 32, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--r-s)", fontSize: "var(--fs-xs)", lineHeight: 1 }}
                    >
                      <span aria-hidden="true">◀</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    title="Expand sidebar"
                    aria-label="Expand message sidebar"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: "3px 5px", borderRadius: "var(--r-s)", fontSize: "var(--fs-xs)", lineHeight: 1, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
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
                      ref={searchInputRef}
                      type="search"
                      className="input"
                      placeholder="Search… ( / )"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="Search inbox (shortcut: /)"
                      style={{ width: "100%", fontSize: "var(--fs-s)" }}
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
                          fontSize: "var(--fs-xs)",
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
                      <div style={{ padding: "20px 16px", textAlign: "center", color: "var(--ink-3)", fontSize: "var(--fs-s)" }}>
                        No items match
                      </div>
                    ) : (
                      filteredItems.map((item) => {
                        const isActive = selected?.name === item.name;
                        const isNew = !seenNames.has(item.name);
                        const title = slugToTitle(item.name);
                        const plainPreview = stripMarkdown(item.preview);
                        return (
                          <button
                            key={item.name}
                            type="button"
                            className={`inbox-item${isActive ? " inbox-item-active" : ""}${isNew ? " inbox-item-new" : ""}`}
                            onClick={() => selectItem(item.name)}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 12,
                              width: "100%",
                              textAlign: "left",
                              padding: "12px 14px",
                              background: isActive ? undefined : "transparent",
                              borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`,
                              borderTop: "none",
                              borderRight: "none",
                              borderBottom: "1px solid var(--line-1)",
                              cursor: "pointer",
                              color: "var(--fg-0)",
                            }}
                            aria-pressed={isActive}
                          >
                            <SenderAvatar name={item.name} size={40} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              {/* Row 1: title + time */}
                              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                <span style={{ flex: 1, fontWeight: isNew ? 700 : 500, fontSize: "var(--fs-m)", color: "var(--ink-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {title}
                                </span>
                                <span style={{ fontSize: "var(--fs-xs)", color: isNew ? "var(--accent-strong)" : "var(--ink-3)", fontWeight: isNew ? 600 : 400, flexShrink: 0 }}>
                                  <RelativeTime iso={item.modifiedAt} />
                                </span>
                              </div>
                              {/* Row 2: preview snippet (Gmail-style, 1 line on mobile) */}
                              {plainPreview && (
                                <div className="inbox-item-preview" style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)", lineHeight: 1.4 }}>
                                  {plainPreview}
                                </div>
                              )}
                            </div>
                            {isNew && (
                              <span aria-label="unread" className="inbox-unread-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, marginTop: 8 }} />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── Right content panel (reader) ── */}
            <div className="inbox-reader-pane" style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
              {detailLoading ? (
                <div
                  role="status"
                  aria-busy="true"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "column",
                    gap: 10,
                    minHeight: 320,
                    padding: "40px",
                  }}
                >
                  <Spinner />
                  <span style={{ fontSize: "var(--fs-m)", color: "var(--ink-2)" }}>Loading message…</span>
                </div>
              ) : selected ? (
                <div className="inbox-reader-body" style={{ padding: "28px 40px 48px", maxWidth: 700 }}>
                  {/* Mobile-only Gmail-style top app bar: back arrow + title.
                      Hidden on desktop where the list is always visible. */}
                  <div className="inbox-mobile-appbar">
                    <button
                      type="button"
                      className="inbox-appbar-back"
                      onClick={() => setSelected(null)}
                      aria-label="Back to message list"
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M19 12H5M12 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <span className="inbox-appbar-spacer" />
                  </div>

                  {/* Large subject (Gmail message screen) */}
                  <h2 className="inbox-reader-subject" style={{ fontWeight: 600, color: "var(--ink-0)", margin: "0 0 14px", lineHeight: 1.3 }}>
                    {slugToTitle(selected.name)}
                  </h2>

                  {/* Sender row: avatar + name + time */}
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, paddingBottom: 14, borderBottom: "1px solid var(--line-1)" }}>
                    <SenderAvatar name={selected.name} size={40} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "var(--fs-m)", fontWeight: 600, color: "var(--ink-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        Local agent
                      </div>
                      <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 2 }}>
                        {new Date(selected.modifiedAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      title="Close"
                      aria-label="Close detail"
                      className="inbox-reader-close-desktop"
                      style={{ background: "none", border: "1px solid var(--line-2)", cursor: "pointer", color: "var(--ink-3)", fontSize: "var(--fs-m)", lineHeight: 1, padding: "4px 8px", borderRadius: "var(--r-s)", flexShrink: 0, transition: "background 120ms" }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Rendered content */}
                  <div
                    ref={detailRef}
                    tabIndex={-1}
                    aria-label={`Message: ${slugToTitle(selected.name)}`}
                    style={{ fontSize: "var(--fs-base)", lineHeight: 1.7, color: "var(--ink-1)", outline: "none", overflowWrap: "break-word", wordBreak: "break-word" }}
                  >
                    <MessageMarkdown
                      content={selected.content}
                      components={markdownComponents}
                    />
                  </div>

                  {/* Italic byline */}
                  <p
                    style={{
                      fontStyle: "italic",
                      fontSize: "var(--fs-s)",
                      color: "var(--ink-3)",
                      marginTop: 24,
                      marginBottom: 20,
                    }}
                  >
                    — written by your local agent. nothing left this machine.
                  </p>

                  {/* Action buttons (bottom) */}
                  {(() => {
                    const recipeNameForSelected = selected.name.replace(/\.md$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
                    return (
                      <>
                      <div className="inbox-reader-actions" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line-1)" }}>
                        <button
                          type="button"
                          className="btn sm primary"
                          style={{ background: "var(--orange)", border: "none", fontSize: "var(--fs-xs)" }}
                          // #600: route to /recipes?run=<name> so the user
                          // lands on the recipe with its vars-input modal
                          // already open. Previously this POSTed directly
                          // and silently 400'd on any recipe with required
                          // vars (which is most of them). Deep-link is
                          // consumed by the recipes page useEffect on load.
                          onClick={() => {
                            router.push(
                              `/recipes?run=${encodeURIComponent(recipeNameForSelected)}`,
                            );
                          }}
                        >
                          Replay recipe
                        </button>
                        <Link
                          // next/link applies the `/dashboard` basePath
                          // automatically — a raw <a href="/traces"> 404s
                          // because it skips the prefix.
                          href={`/traces?q=${encodeURIComponent(recipeNameForSelected)}`}
                          className="btn sm ghost"
                          style={{ fontSize: "var(--fs-xs)", textDecoration: "none" }}
                        >
                          View trace
                        </Link>
                        <button
                          type="button"
                          className="btn sm ghost"
                          style={{ fontSize: "var(--fs-xs)", color: "var(--ink-3)" }}
                          onClick={async () => {
                            const proceed = window.confirm(
                              `Archive "${selected.name}"? It will be moved to ~/.patchwork/inbox/.archive and hidden from the list.`,
                            );
                            if (!proceed) return;
                            try {
                              const res = await fetch(
                                apiPath(
                                  `/api/bridge/inbox/${encodeURIComponent(selected.name)}/archive`,
                                ),
                                { method: "POST" },
                              );
                              if (!res.ok) {
                                const text = await res.text().catch(() => res.statusText);
                                toast.error(`Archive failed: ${text || res.status}`);
                                return;
                              }
                              toast.success(`Archived “${selected.name}”`);
                              fetchList(true);
                              setSelected(null);
                            } catch (e) {
                              toast.error(
                                e instanceof Error ? e.message : String(e),
                              );
                            }
                          }}
                        >
                          Archive
                        </button>
                        <button
                          type="button"
                          className="btn sm ghost"
                          style={{ fontSize: "var(--fs-xs)", color: "var(--err)" }}
                          onClick={async () => {
                            const proceed = window.confirm(
                              `Permanently delete "${selected.name}"? This cannot be undone.`,
                            );
                            if (!proceed) return;
                            try {
                              const res = await fetch(
                                apiPath(`/api/bridge/inbox/${encodeURIComponent(selected.name)}`),
                                { method: "DELETE" },
                              );
                              if (!res.ok) {
                                const text = await res.text().catch(() => res.statusText);
                                toast.error(`Delete failed: ${text || res.status}`);
                                return;
                              }
                              toast.success(`Deleted “${selected.name}”`);
                              fetchList(true);
                              setSelected(null);
                            } catch (e) {
                              toast.error(
                                e instanceof Error ? e.message : String(e),
                              );
                            }
                          }}
                        >
                          Delete permanently
                        </button>
                      </div>
                    </>
                    );
                  })()}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-3)" }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M2 7l10 7 10-7"/>
                  </svg>
                  <p style={{ fontSize: "var(--fs-m)", color: "var(--ink-2)", margin: 0, fontWeight: 500 }}>
                    Select a message to read it
                  </p>
                  {filteredItems.length > 0 && (
                    <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-3)", margin: 0 }}>
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
