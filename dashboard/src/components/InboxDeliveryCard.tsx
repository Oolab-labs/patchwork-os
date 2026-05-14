"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Discovery card surfaced on /inbox to advertise that briefs and digests
 * can be pushed to the user's phone (iMessage, ntfy, webhook, email).
 *
 * Most users today have to come back to /inbox in a browser to read
 * what their recipes produced overnight — the whole point of an
 * automated morning brief evaporates the moment "go check the
 * dashboard" enters the loop. This card is the discoverability hook
 * that takes them to a settings panel where they can wire a real
 * delivery channel.
 *
 * Dismissable via localStorage. Variant supports a compact form that
 * lives inside the EmptyState when the inbox has no items — same CTA,
 * different copy and weight.
 */

const STORAGE_KEY = "patchwork.inbox.deliveryCardDismissed";

interface InboxDeliveryCardProps {
  /** "card" (default, full chrome) or "empty" (compact, lives inside EmptyState). */
  variant?: "card" | "empty";
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}

function PhoneIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 19h2" />
    </svg>
  );
}

export function InboxDeliveryCard({ variant = "card" }: InboxDeliveryCardProps) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  if (variant === "card" && dismissed) return null;

  if (variant === "empty") {
    // Compact variant: lives inside the inbox EmptyState. The empty-state
    // already conveys "no items"; this row reframes the absence as an
    // opportunity ("set up phone delivery so you don't have to come back
    // here"). Single-line, no dismissal — the EmptyState itself goes away
    // as soon as items arrive.
    return (
      <div
        style={{
          marginTop: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderRadius: "var(--r-2)",
          border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
          background: "color-mix(in srgb, var(--accent) 6%, var(--surface))",
          fontSize: "var(--fs-s)",
        }}
      >
        <span style={{ color: "var(--accent)", display: "inline-flex" }}>
          <PhoneIcon />
        </span>
        <span style={{ color: "var(--ink-1)" }}>
          Want briefs on your phone?
        </span>
        <Link
          href="/settings/inbox-delivery"
          style={{
            color: "var(--accent)",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Set up delivery →
        </Link>
      </div>
    );
  }

  return (
    <aside
      role="note"
      aria-labelledby="inbox-delivery-card-title"
      style={{
        marginTop: 12,
        marginBottom: 14,
        padding: "14px 18px",
        borderRadius: "var(--r-3)",
        border: "1px solid color-mix(in srgb, var(--accent) 26%, transparent)",
        background: "color-mix(in srgb, var(--accent) 7%, var(--surface))",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto",
        alignItems: "center",
        gap: 14,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "color-mix(in srgb, var(--accent) 18%, transparent)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <PhoneIcon />
      </span>
      <div style={{ minWidth: 0 }}>
        <strong
          id="inbox-delivery-card-title"
          style={{
            display: "block",
            fontSize: "var(--fs-s)",
            color: "var(--ink-0)",
            marginBottom: 2,
            fontWeight: 700,
          }}
        >
          Get your inbox on your phone
        </strong>
        <div
          style={{
            fontSize: "var(--fs-xs)",
            color: "var(--ink-2)",
            lineHeight: 1.45,
          }}
        >
          Deliver briefs and recipe outputs to iMessage, ntfy push, or any
          HTTP endpoint — read them where you actually are, not where the
          dashboard lives.
        </div>
      </div>
      <Link
        href="/settings/inbox-delivery"
        style={{
          fontSize: "var(--fs-s)",
          fontWeight: 600,
          padding: "6px 14px",
          borderRadius: "var(--r-2)",
          border: "1px solid var(--accent)",
          background: "var(--accent)",
          color: "var(--on-orange, #fff)",
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Set up →
      </Link>
      <button
        type="button"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
        aria-label="Dismiss inbox delivery hint"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--ink-3)",
          cursor: "pointer",
          fontSize: "var(--fs-s)",
          padding: "4px 6px",
        }}
      >
        ✕
      </button>
    </aside>
  );
}
