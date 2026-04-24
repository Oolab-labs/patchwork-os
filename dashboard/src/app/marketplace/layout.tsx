import type { ReactNode } from "react";
import Link from "next/link";
import { DemoBanner } from "@/components/DemoBanner";

export const metadata = { title: "Marketplace — Patchwork OS" };

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="2" y="2"  width="12" height="12" rx="3" fill="var(--orange)" />
      <rect x="18" y="2" width="12" height="12" rx="3" fill="var(--orange)" opacity="0.7" />
      <rect x="2" y="18" width="12" height="12" rx="3" fill="var(--orange)" opacity="0.7" />
      <rect x="18" y="18" width="12" height="12" rx="3" fill="var(--orange)" opacity="0.4" />
    </svg>
  );
}

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-0)", color: "var(--fg-0)" }}>
      <DemoBanner />
      {/* public header — no sidebar */}
      <header
        style={{
          borderBottom: "1px solid var(--border-default)",
          padding: "0 var(--s-6)",
          height: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "sticky",
          top: 0,
          background: "var(--bg-0)",
          zIndex: 50,
        }}
      >
        <Link
          href="/marketplace"
          style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "var(--fg-0)" }}
        >
          <BrandMark />
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em" }}>Patchwork OS</span>
          <span style={{ color: "var(--fg-3)", fontSize: 13, marginLeft: 2 }}>Marketplace</span>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a
            href="https://github.com/Oolab-labs/claude-ide-bridge"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13, color: "var(--fg-2)", textDecoration: "none" }}
          >
            Docs
          </a>
          <Link
            href="/"
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "5px 14px",
              borderRadius: "var(--r-full)",
              background: "var(--accent-soft)",
              color: "var(--accent-strong)",
              border: "1px solid rgba(99,102,241,0.25)",
              textDecoration: "none",
            }}
          >
            Dashboard →
          </Link>
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--s-8) var(--s-6)" }}>
        {children}
      </main>
    </div>
  );
}
