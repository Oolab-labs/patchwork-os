"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { usePaneShortcut } from "@/hooks/usePaneShortcuts";

/**
 * Global "?" overlay — keyboard shortcut cheatsheet.
 *
 * Several keyboard affordances exist across the dashboard (⌘K palette,
 * j/k row nav, / for search, E/X for approve/reject on /approvals)
 * but none of them are surfaced anywhere. New users only learn about
 * them from blame or word of mouth.
 *
 * Mount once in Shell. Press "?" anywhere outside an input to open;
 * Esc / backdrop click to close.
 */

interface Shortcut {
  keys: string[];
  label: string;
  scope?: string;
}

// Ordered global-first then page-scoped. Keep tight — the goal is
// "things you can do right now," not exhaustive documentation.
const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], label: "Open command palette", scope: "Global" },
  { keys: ["Ctrl", "K"], label: "Open command palette (Windows / Linux)", scope: "Global" },
  { keys: ["?"], label: "Show this cheatsheet", scope: "Global" },
  { keys: ["Esc"], label: "Close dialog / overlay", scope: "Global" },
  { keys: ["/"], label: "Focus search input", scope: "Pages with search" },
  { keys: ["j"], label: "Next row", scope: "/tasks · /recipes · /runs" },
  { keys: ["k"], label: "Previous row", scope: "/tasks · /recipes · /runs" },
  { keys: ["E"], label: "Approve the focused call", scope: "/approvals" },
  { keys: ["X"], label: "Reject the focused call", scope: "/approvals" },
];

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);

  usePaneShortcut(
    (e) => {
      if (e.key !== "?") return;
      e.preventDefault();
      setOpen((v) => !v);
    },
    [],
  );

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      ariaLabelledBy="kbd-shortcuts-title"
      maxWidth={520}
    >
      <h2
        id="kbd-shortcuts-title"
        style={{
          margin: "0 0 var(--s-4) 0",
          fontSize: "var(--fs-xl)",
          fontWeight: 600,
        }}
      >
        Keyboard shortcuts
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          rowGap: 10,
          columnGap: 16,
          alignItems: "center",
        }}
      >
        {SHORTCUTS.map((s) => (
          <ShortcutRow key={`${s.scope}-${s.label}`} shortcut={s} />
        ))}
      </div>
      <p
        style={{
          marginTop: "var(--s-5)",
          marginBottom: 0,
          fontSize: "var(--fs-xs)",
          color: "var(--ink-3)",
        }}
      >
        Press <KeyChip>?</KeyChip> again to close. Shortcuts are disabled
        while typing in an input field.
      </p>
    </Dialog>
  );
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  return (
    <>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {shortcut.keys.map((k, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <KeyChip>{k}</KeyChip>
            {i < shortcut.keys.length - 1 && (
              <span style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>+</span>
            )}
          </span>
        ))}
      </div>
      <div style={{ fontSize: "var(--fs-m)", color: "var(--ink-1)" }}>
        {shortcut.label}
      </div>
      <div
        style={{
          fontSize: "var(--fs-xs)",
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono)",
          textAlign: "right",
        }}
      >
        {shortcut.scope}
      </div>
    </>
  );
}

function KeyChip({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 22,
        height: 22,
        padding: "0 6px",
        fontSize: "var(--fs-xs)",
        fontFamily: "var(--font-mono)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-2)",
        borderBottomWidth: 2,
        borderRadius: 4,
        color: "var(--ink-0)",
        lineHeight: 1,
      }}
    >
      {children}
    </kbd>
  );
}
