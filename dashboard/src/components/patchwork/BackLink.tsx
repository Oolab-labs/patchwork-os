import Link from "next/link";
import type { CSSProperties } from "react";

/**
 * Consistent "← Parent" link for detail pages.
 *
 * Before this primitive, six different detail pages each rolled their
 * own inline `<Link>` with slightly different copy ("← Approvals",
 * "← Back to queue", "← Back to recipes") and slightly different
 * inline styles. The IA audit flagged this as low-grade
 * disjointedness — small visual drift, repeated 6 times.
 *
 * Usage:
 *   <BackLink href="/runs" label="Runs" />
 *   <BackLink href="/approvals" label="Approvals" />
 *
 * Renders as a small caret-prefixed link sized to sit above the page H1.
 * The component itself is wrapper-free; drop it directly inside your
 * `.page-head` block (or wrap in your own positioning div if needed).
 */
export interface BackLinkProps {
  href: string;
  label: string;
  /** Optional inline style override (escape hatch only). */
  style?: CSSProperties;
}

export function BackLink({ href, label, style }: BackLinkProps) {
  return (
    <div
      style={{
        fontSize: "var(--fs-s)",
        marginBottom: 4,
        ...style,
      }}
    >
      <Link
        href={href}
        style={{ color: "var(--fg-2)", textDecoration: "none" }}
      >
        ← {label}
      </Link>
    </div>
  );
}
