"use client";

import { formatConnectorLabel, normalizeConnectorId } from "@/lib/registry";

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
 * Wave 1 fix: each connector now gets its OWN row with a deep-link
 * straight to `/connections#<connector-id>` (the connections page
 * scrolls to the anchor, so the user lands on the right row). The old
 * version was a single comma-joined label list with one generic
 * "Open connections →" button that dumped every user on the same
 * index — a textbook dead-end. The `<a>` is intentionally raw (not
 * Next `<Link>`) because Next's router strips hash fragments on
 * client-side navigation.
 *
 * Renders as a `role="alert"` block so screen readers announce the
 * full list. Each link reads "Connect Gmail" → screen readers say
 * "Connect Gmail, link".
 */
export function MissingConnectorsNotice({
  connectors,
}: {
  connectors: string[];
}) {
  if (connectors.length === 0) return null;
  // Normalise display ids so a recipe that imported as `googleCalendar`
  // still lands on `/connections#google-calendar`, matching the
  // canonical id used on that page's anchor targets.
  const items = connectors.map((raw) => {
    const id = normalizeConnectorId(raw);
    return { id, label: formatConnectorLabel(id) };
  });
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
          Connect {items.length === 1 ? "this service" : "these services"}{" "}
          before the recipe can run:
        </strong>
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-1)",
        }}
      >
        {items.map(({ id, label }) => (
          <li key={id}>
            <a
              href={`/connections#${id}`}
              className="btn sm"
              style={{
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Connect {label} →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
