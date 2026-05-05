"use client";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Recipes" | "Approvals" | "Actions";
  perform: () => void;
}

const NAV_DESTINATIONS: { href: string; label: string; hint?: string }[] = [
  { href: "/", label: "Overview", hint: "Home" },
  { href: "/inbox", label: "Inbox" },
  { href: "/approvals", label: "Approvals — Pending" },
  { href: "/suggestions", label: "Approvals — Suggested" },
  { href: "/decisions", label: "Approvals — History" },
  { href: "/activity", label: "Activity — Live" },
  { href: "/runs", label: "Activity — Runs" },
  { href: "/tasks", label: "Activity — Tasks" },
  { href: "/sessions", label: "Activity — Sessions" },
  { href: "/traces", label: "Activity — Traces" },
  { href: "/recipes", label: "Recipes" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/analytics", label: "Analytics — Overview" },
  { href: "/insights", label: "Analytics — Insights" },
  { href: "/metrics", label: "Analytics — Metrics" },
  { href: "/transactions", label: "Transactions" },
  { href: "/connections", label: "Connections" },
  { href: "/settings", label: "Settings" },
];

function score(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 500;
  if (h.includes(n)) return 250;
  // Subsequence match (fuzzy): every char of n appears in order in h.
  let hi = 0;
  let matched = 0;
  for (let ni = 0; ni < n.length; ni++) {
    while (hi < h.length && h[hi] !== n[ni]) hi++;
    if (hi >= h.length) return 0;
    matched++;
    hi++;
  }
  return matched === n.length ? 100 - (h.length - n.length) : 0;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [recipes, setRecipes] = useState<{ name: string }[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<
    { callId: string; toolName: string }[]
  >([]);

  // Lazily fetch dynamic data the first time the palette opens; cache for the
  // session. Both endpoints are demo-safe (return mock fixtures when bridge
  // offline) so we don't need to gate on bridge status here.
  useEffect(() => {
    if (!open) return;
    if (recipes.length === 0) {
      fetch(apiPath("/api/bridge/recipes"))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const list = (d?.recipes ?? d ?? []) as { name?: string }[];
          setRecipes(list.filter((r) => r.name).map((r) => ({ name: r.name as string })));
        })
        .catch(() => {});
    }
    if (pendingApprovals.length === 0) {
      fetch(apiPath("/api/bridge/approvals"))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const list = (d?.pending ?? d ?? []) as { callId?: string; toolName?: string }[];
          setPendingApprovals(
            list
              .filter((a) => a.callId && a.toolName)
              .slice(0, 20)
              .map((a) => ({ callId: a.callId as string, toolName: a.toolName as string })),
          );
        })
        .catch(() => {});
    }
  }, [open, recipes.length, pendingApprovals.length]);

  const commands = useMemo<Command[]>(() => {
    const navCmds: Command[] = NAV_DESTINATIONS.map((d) => ({
      id: `nav:${d.href}`,
      label: d.label,
      hint: d.hint ?? d.href,
      group: "Navigate" as const,
      perform: () => router.push(d.href),
    }));
    const recipeCmds: Command[] = recipes.map((r) => ({
      id: `recipe:${r.name}`,
      label: r.name,
      hint: "Open recipe",
      group: "Recipes" as const,
      perform: () => router.push(`/recipes/${encodeURIComponent(r.name)}`),
    }));
    const approvalCmds: Command[] = pendingApprovals.map((a) => ({
      id: `approval:${a.callId}`,
      label: a.toolName,
      hint: a.callId.slice(0, 12),
      group: "Approvals" as const,
      perform: () => router.push(`/approvals#${a.callId}`),
    }));
    const actionCmds: Command[] = [
      {
        id: "action:toggle-theme",
        label: "Toggle theme (paper / dark / system)",
        group: "Actions",
        perform: () => {
          const order = ["paper", "dark", "system"] as const;
          const current = (localStorage.getItem("patchwork-theme") ??
            "system") as (typeof order)[number];
          const idx = order.indexOf(current);
          const next = order[(idx + 1) % order.length];
          localStorage.setItem("patchwork-theme", next);
          window.dispatchEvent(new Event("patchwork-theme-change"));
        },
      },
      {
        id: "action:reload",
        label: "Reload window",
        group: "Actions",
        perform: () => window.location.reload(),
      },
    ];
    return [...navCmds, ...recipeCmds, ...approvalCmds, ...actionCmds];
  }, [router, recipes, pendingApprovals]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, s: score(c.label, query) + (c.hint ? score(c.hint, query) * 0.3 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, query]);

  // Reset state and restore focus on close.
  const previousActiveRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      previousActiveRef.current =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      // Restore focus to the trigger that opened the palette.
      previousActiveRef.current?.focus?.();
    }
  }, [open]);

  // Clamp activeIdx when filter changes
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  // Scroll active row into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[activeIdx];
        if (cmd) {
          cmd.perform();
          onClose();
        }
        return;
      }
      if (e.key === "Tab") {
        // Trap focus inside the palette: only the input is tab-focusable,
        // so any Tab/Shift-Tab simply keeps focus on the input.
        e.preventDefault();
        inputRef.current?.focus();
      }
    },
    [filtered, activeIdx, onClose],
  );

  if (!open) return null;

  // Group rows by group, but track absolute index for keyboard nav.
  const grouped: { group: string; items: { cmd: Command; idx: number }[] }[] = [];
  filtered.forEach((cmd, idx) => {
    const last = grouped[grouped.length - 1];
    if (last && last.group === cmd.group) last.items.push({ cmd, idx });
    else grouped.push({ group: cmd.group, items: [{ cmd, idx }] });
  });

  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={handleKey}
    >
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to anything…"
            aria-label="Command palette query"
          />
          <span className="kbd">esc</span>
        </div>
        <ul className="cmdk-list" ref={listRef} role="listbox">
          {filtered.length === 0 && (
            <li className="cmdk-empty">No matches</li>
          )}
          {grouped.map((g) => (
            <Fragment key={g.group}>
              <li className="cmdk-group" aria-hidden="true">{g.group}</li>
              {g.items.map(({ cmd, idx }) => (
                <li
                  key={cmd.id}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === activeIdx}
                  className={`cmdk-row${idx === activeIdx ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => {
                    cmd.perform();
                    onClose();
                  }}
                >
                  <span className="cmdk-row-label">{cmd.label}</span>
                  {cmd.hint && <span className="cmdk-row-hint">{cmd.hint}</span>}
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
      </div>
    </div>
  );
}
