"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { apiPath } from "@/lib/api";
import { inboxItemKey } from "@/lib/entityKey";
import { stripMarkdown } from "@/lib/textPreview";
import { EmptyState, ErrorState, HintCard, RelationStrip } from "@/components/patchwork";
import { RecipeChip, RunChip } from "@/components/patchwork/entity";
import { SkeletonList } from "@/components/Skeleton";
import { InboxDeliveryCard } from "@/components/InboxDeliveryCard";
import { useToast } from "@/components/Toast";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
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

/** Provenance frontmatter the bridge writes onto inbox files (PR #742).
 *  Optional + additive — older files without frontmatter have no
 *  `provenance` and the UI suppresses the header strip. */
interface InboxProvenance {
  recipe?: string;
  runSeq?: number;
  trigger?: string;
  deliveredAt?: number;
}

interface InboxItem {
  name: string;
  path: string;
  modifiedAt: string;
  preview: string;
  provenance?: InboxProvenance;
}

interface InboxDetail {
  name: string;
  content: string;
  modifiedAt: string;
  provenance?: InboxProvenance;
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
      style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.42) }}
    >
      {avatarInitial(title)}
    </span>
  );
}

// ------------------------------------------------------------------ preview strip

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
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);
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
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
    });
  }, []);
  return (
    <h2 ref={headingRef} className="inbox-md-h2">
      <span className="inbox-md-h2-text">{children}</span>
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
    <h1 className="inbox-md-h1">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => <H2WithCopy>{children}</H2WithCopy>,
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="inbox-md-h3">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="inbox-md-p">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="inbox-md-ul">{children}</ul>
  ),
  hr: () => <hr className="inbox-md-hr" />,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="inbox-md-strong">{children}</strong>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="inbox-md-li">{children}</li>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="inbox-md-pre">{children}</pre>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = !!className;
    return isBlock ? (
      <code className="inbox-md-code-block">{children}</code>
    ) : (
      <code className="inbox-md-code-inline">{children}</code>
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
      className="inbox-spinner"
      style={{ width: size, height: size }}
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

// CSS for this page has been moved to globals.css (inbox/* namespace).

export default function InboxPage() {
  const [selected, setSelected] = useState<InboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Pause polling while the tab is hidden — `useBridgeFetch` polls on a
  // fixed interval, so we gate `enabled` on document visibility to keep
  // the prior visibilitychange-aware behavior.
  const [tabVisible, setTabVisible] = useState(true);
  const searchInputRef = useSearchHotkey();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filterFromUrl = searchParams?.get("filter");
  const itemFromUrl = searchParams?.get("item") ?? "";
  const recipeFromUrl = searchParams?.get("recipe") ?? "";
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
  const [seenNames] = useState<Set<string>>(() => new Set());
  const toast = useToast();
  const detailRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<InboxDetail | null>(null);
  selectedRef.current = selected;
  // Tracks whether seenNames has been seeded from the first successful
  // list response — keeps the "new" badge logic identical to the prior
  // `prev.length === 0` first-load check.
  const seededRef = useRef(false);

  // List data, polling, retry/backoff and abort-on-unmount are all
  // handled by the shared hook. Polling pauses while the tab is hidden.
  const {
    data: listData,
    error: listError,
    loading,
    refetch,
  } = useBridgeFetch<{ items: InboxItem[] }>("/api/inbox", {
    intervalMs: 30_000,
    enabled: tabVisible,
  });
  const items = listData?.items ?? [];

  useEffect(() => {
    const onVisible = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Seed seenNames on the first successful load so existing items don't
  // show the "new" badge. Items that arrive on later polls stay unseen.
  useEffect(() => {
    if (!seededRef.current && listData) {
      for (const item of listData.items ?? []) seenNames.add(item.name);
      seededRef.current = true;
    }
  }, [listData, seenNames]);

  // Auto-refresh the open message when the list reports it changed
  // upstream — preserves the prior behavior where a poll that detected a
  // newer modifiedAt re-fetched the detail body.
  useEffect(() => {
    const cur = selectedRef.current;
    if (!cur || !listData) return;
    const updated = listData.items?.find((i) => i.name === cur.name);
    if (!updated || updated.modifiedAt === cur.modifiedAt) return;
    let alive = true;
    void fetch(apiPath(`/api/inbox/${encodeURIComponent(cur.name)}`))
      .then((res) => (res.ok ? res.json() : null))
      .then((detail) => {
        if (alive && detail) setSelected(detail as InboxDetail);
      })
      .catch(() => {
        /* transient — next poll retries */
      });
    return () => {
      alive = false;
    };
  }, [listData]);

  // Auto-select item from ?item= param on first load.
  const itemParamHandledRef = useRef(false);
  useEffect(() => {
    if (loading || itemParamHandledRef.current) return;
    if (itemFromUrl && items.length > 0) {
      itemParamHandledRef.current = true;
      const match = items.find((i) => i.name === itemFromUrl);
      if (match) {
        void selectItem(match.name);
        return;
      }
    }
    // Auto-select first item after initial load if nothing is selected
    if (items.length > 0 && !selected && !detailLoading && !itemFromUrl) {
      void selectItem(items[0].name);
    }
    // Only on initial load — don't re-trigger on polling updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

const filteredItems = items.filter((item) => {
    if (recipeFromUrl && item.provenance?.recipe !== recipeFromUrl) return false;
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
    setDetailErr(undefined);
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
      setDetailErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }

  const unseen = items.filter((i) => !seenNames.has(i.name)).length;

  return (
    <section className="inbox-page-section">
      {/* Page header */}
      <div className="page-head inbox-page-head">
        <div>
          <div className="page-head-title-row">
            <h1 className="editorial-h1 inbox-h1">
              Inbox — <span className="accent">what your agents wrote you.</span>
            </h1>
            <HintCard.Toggle id="inbox" />
          </div>
          <div className="editorial-sub">~/.patchwork/inbox · briefs · summaries · agent reports</div>
          <RelationStrip
            items={[
              { label: "Recipes", href: "/recipes", title: "Recipes that produce inbox items" },
              { label: "Runs", href: "/runs", title: "Runs that generated these messages" },
              { label: "Traces", href: "/traces", title: "Decisions tied to these outputs" },
              { label: "Connections", href: "/connections", title: "Connectors used to source content" },
            ]}
          />
        </div>
        <div className="inbox-head-actions">
          {unseen > 0 && (
            <span className="pill info inbox-head-pill">
              {unseen} new
            </span>
          )}
          <span className="pill muted inbox-head-pill">
            {items.length} item{items.length !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={loading}
            title="Refresh"
            className="inbox-refresh-btn"
          >
            {loading ? (
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

      {recipeFromUrl && (
        <div className="inbox-recipe-filter">
          <span className="inbox-recipe-filter-label">Filtered by recipe:</span>
          <code>{recipeFromUrl}</code>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              const params = new URLSearchParams(searchParams?.toString() ?? "");
              params.delete("recipe");
              const qs = params.toString();
              router.replace(qs ? `?${qs}` : "/inbox", { scroll: false });
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/*
        Discovery card for the "deliver to phone" capability. Lives
        above the items list so it surfaces to every user who hasn't
        dismissed it — the people who already use /inbox in a browser
        are exactly the audience for "stop coming here, get pushed".
      */}
      <InboxDeliveryCard />

      {/* Stale-data refresh error: list still has items, but the last
          poll failed. Inline banner only — the populated list stays
          visible below. The empty-on-error case is handled by the
          ErrorState in the block further down. */}
      {listError && items.length > 0 && (
        <div className="alert-err mb-3" role="alert">
          Refresh failed — {listError}
        </div>
      )}

      {loading && items.length === 0 ? (
        <SkeletonList rows={5} columns={2} />
      ) : listError && items.length === 0 ? (
        <ErrorState
          title="Couldn't load inbox"
          description="The bridge isn't responding. The inbox will reload on its next tick."
          error={listError}
          onRetry={refetch}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M2 7l10 7 10-7" />
            </svg>
          }
          title="Your inbox is empty"
          description={
            <>
              <span>Inbox items are created by recipes — morning briefs, health checks, agent reports, and summaries all land here. Run your first recipe to see an output.</span>
              <div>
                <InboxDeliveryCard variant="empty" />
              </div>
            </>
          }
          action={
            <Link href="/recipes" className="btn sm">
              Run a recipe →
            </Link>
          }
        />
      ) : (
        <div
          className={`inbox-twopane${selected ? " inbox-twopane--reader" : " inbox-twopane--list"}`}
        >

          {/* ── Left sidebar (list) ── */}
          <div
            className="inbox-list-pane"
            data-open={String(sidebarOpen)}
          >

            {/* Sidebar header */}
            <div className="inbox-sidebar-header">
              {sidebarOpen ? (
                <>
                  <span className="inbox-sidebar-label">Messages</span>
                  {unseen > 0 && (
                    <span className="pill info inbox-sidebar-new-pill">{unseen} new</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(false)}
                    title="Collapse sidebar"
                    aria-label="Collapse message sidebar"
                    className="inbox-sidebar-collapse-btn"
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
                  className="inbox-sidebar-expand-btn"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M2 7l10 7 10-7"/>
                  </svg>
                  {unseen > 0 && (
                    <span className="inbox-expand-dot" />
                  )}
                </button>
              )}
            </div>

            {sidebarOpen && (
              <>
                {/* Search */}
                <div className="inbox-search-wrap">
                  <input
                    ref={searchInputRef}
                    type="search"
                    className="input inbox-search-input"
                    placeholder="Search… ( / )"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search inbox (shortcut: /)"
                  />
                </div>

                {/* Category filter chips */}
                <div className="inbox-cat-chips">
                  {FILTER_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setActiveFilter(cat)}
                      className="inbox-cat-btn"
                      data-active={String(activeFilter === cat)}
                      aria-pressed={activeFilter === cat}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {/* Item list */}
                <div className="inbox-list-scroll">
                  {filteredItems.length === 0 ? (
                    <div className="inbox-list-empty">No items match</div>
                  ) : (
                    filteredItems.map((item, idx) => {
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
                          aria-pressed={isActive}
                          style={{ animationDelay: `${Math.min(idx * 25, 160)}ms` }}
                        >
                          <SenderAvatar name={item.name} size={40} />
                          <div className="inbox-item-content">
                            {/* Row 1: title + time */}
                            <div className="inbox-item-title-row">
                              <span className="inbox-item-title" data-new={String(isNew)}>
                                {title}
                              </span>
                              <span className="inbox-item-time" data-new={String(isNew)}>
                                <RelativeTime iso={item.modifiedAt} />
                              </span>
                            </div>
                            {/* Row 2: preview snippet (Gmail-style, 2 lines) */}
                            {plainPreview && (
                              <div className="inbox-item-preview">{plainPreview}</div>
                            )}
                          </div>
                          {isNew && (
                            <span aria-label="unread" className="inbox-unread-dot" />
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
          <div className="inbox-reader-pane">
            {detailLoading ? (
              <div role="status" aria-busy="true" className="inbox-reader-loading">
                <Spinner />
                <span className="inbox-reader-loading-text">Loading message…</span>
              </div>
            ) : detailErr ? (
              <div className="inbox-reader-error-wrap">
                <ErrorState
                  title="Couldn't open this message"
                  description="The bridge couldn't return this message body. Try selecting it again."
                  error={detailErr}
                />
              </div>
            ) : selected ? (
              <div className="inbox-reader-body">
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
                <h2 className="inbox-reader-subject">
                  {slugToTitle(selected.name)}
                </h2>

                {/* Sender row: avatar + provenance (when present) + time.
                    With provenance frontmatter (PR #742) we render a
                    truthful "Produced by <recipe> · run <#seq>" strip.
                    Without it we suppress the legacy "Local agent" guess
                    — silence is more honest than a generic label. */}
                <div className="inbox-sender-row">
                  <SenderAvatar name={selected.name} size={40} />
                  <div className="inbox-sender-meta">
                    {selected.provenance?.recipe && (
                      <div className="inbox-provenance-row">
                        <span className="inbox-provenance-label">Produced by</span>
                        <RecipeChip
                          name={selected.provenance.recipe}
                          trigger={selected.provenance.trigger}
                          variant="link"
                        />
                        {selected.provenance.runSeq !== undefined && (
                          <>
                            <span className="inbox-provenance-label">· run</span>
                            <RunChip
                              seq={selected.provenance.runSeq}
                              recipeName={selected.provenance.recipe}
                              variant="link"
                            />
                          </>
                        )}
                      </div>
                    )}
                    <div className="inbox-sender-date">
                      {new Date(selected.modifiedAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    title="Close"
                    aria-label="Close detail"
                    className="inbox-reader-close-desktop"
                  >
                    ✕
                  </button>
                </div>

                {/* Rendered content */}
                <div
                  ref={detailRef}
                  tabIndex={-1}
                  aria-label={`Message: ${slugToTitle(selected.name)}`}
                  className="inbox-reader-content"
                >
                  <MessageMarkdown
                    content={selected.content}
                    components={markdownComponents}
                  />
                </div>

                {/* Italic byline */}
                <p className="inbox-reader-byline">
                  — written by your local agent. nothing left this machine.
                </p>

                {/* Action buttons (bottom) */}
                {(() => {
                  // Prefer provenance.recipe (PR #742 frontmatter) over
                  // a filename-regex guess. Older files without
                  // provenance fall back to the .md-stripped filename
                  // — the recipes page no-ops gracefully on a miss.
                  const recipeNameForSelected =
                    selected.provenance?.recipe ?? inboxItemKey(selected.name);
                  return (
                    <>
                    <div className="inbox-reader-actions">
                      <button
                        type="button"
                        className="btn sm primary inbox-action-btn"
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
                        className="btn sm ghost inbox-action-btn"
                      >
                        View trace
                      </Link>
                      <button
                        type="button"
                        className="btn sm ghost inbox-action-btn inbox-action-muted"
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
                            toast.success(`Archived "${selected.name}"`);
                            refetch();
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
                        className="btn sm ghost inbox-action-btn inbox-action-danger"
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
                            toast.success(`Deleted "${selected.name}"`);
                            refetch();
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
              <div className="inbox-reader-empty">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <path d="M2 7l10 7 10-7"/>
                </svg>
                <p className="inbox-reader-empty-title">
                  Select a message to read it
                </p>
                {filteredItems.length > 0 && (
                  <p className="inbox-reader-empty-count">
                    {filteredItems.length} message{filteredItems.length !== 1 ? "s" : ""} in this view
                  </p>
                )}
              </div>
            )}
          </div>

        </div>
      )}
    </section>
  );
}
