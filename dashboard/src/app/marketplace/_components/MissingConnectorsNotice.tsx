"use client";

import Link from "next/link";
import { formatConnectorLabel } from "@/lib/registry";

/**
 * Post-install warning rendered on InstallPanel / BundleInstallPanel
 * when the bridge's connectorPreflight ships back a non-empty
 * `missingConnectors[]` on the install response.
 *
 * Why inline (not toast): the browse view fires a transient toast on
 * the same event, but detail-page users typically land from a share
 * link, install, and immediately try to run — they need a persistent
 * notice that survives the page sitting open. Toast auto-dismisses
 * after 8s and gives them nothing to come back to.
 *
 * Renders connectors as a comma-separated label list with a single
 * action link to /connections. No "Dismiss" button — the notice
 * disappears once the install state changes (e.g. on a successful
 * re-install) or the page reloads.
 */
export function MissingConnectorsNotice({
  connectors,
}: {
  connectors: string[];
}) {
  if (connectors.length === 0) return null;
  const labels = connectors.map(formatConnectorLabel);
  return (
    <div
      role="alert"
      style={{
        background: "var(--warn-soft)",
        border: "1px solid var(--warn)",
        borderRadius: "var(--r-2)",
        padding: "var(--s-3) var(--s-4)",
        fontSize: "var(--fs-s)",
        color: "var(--ink-1)",
        lineHeight: 1.55,
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
      }}
    >
      <div>
        <strong style={{ color: "var(--ink-0)" }}>
          Connect {labels.length === 1 ? "this service" : "these services"}{" "}
          before the recipe can run:
        </strong>{" "}
        {labels.join(", ")}.
      </div>
      <div>
        <Link
          href="/connections"
          className="btn sm"
          style={{ textDecoration: "none" }}
        >
          Open connections →
        </Link>
      </div>
    </div>
  );
}
