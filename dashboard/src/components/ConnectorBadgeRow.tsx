"use client";

import { normalizeConnectorId } from "@/lib/registry";

const KNOWN_SVGS = new Set([
  "gmail", "google-calendar", "google-drive", "linear", "github",
  "slack", "asana", "discord", "gitlab", "jira", "confluence",
  "notion", "hubspot", "sentry",
]);

function initials(id: string): string {
  const norm = id.toLowerCase().replace(/[^a-z]/g, "");
  if (norm === "googlecalendar" || norm === "calendar" || norm === "google-calendar") return "GC";
  if (norm === "googledrive" || norm === "google-drive") return "GD";
  return norm.slice(0, 2).toUpperCase();
}

function ConnectorGlyph({ id }: { id: string }) {
  if (KNOWN_SVGS.has(id)) {
    const url = `/connectors/${id}.svg`;
    return (
      <span
        role="img"
        aria-label={id}
        style={{
          display: "block",
          width: 14,
          height: 14,
          flexShrink: 0,
          color: "var(--ink-2)",
          background: "currentColor",
          mask: `url(${url}) center/contain no-repeat`,
          WebkitMask: `url(${url}) center/contain no-repeat`,
        }}
      />
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        borderRadius: 4,
        background: "var(--bg-2)",
        color: "var(--ink-3)",
        fontSize: 7,
        fontWeight: 700,
        flexShrink: 0,
        letterSpacing: 0,
      }}
    >
      {initials(id)}
    </span>
  );
}

export function ConnectorBadgeRow({ connectors }: { connectors: string[] }) {
  const visible = connectors.slice(0, 2).map(normalizeConnectorId);
  const overflow = connectors.length - 2;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      {visible.map((c, i) => (
        <span
          key={i}
          title={c}
          aria-label={c}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "var(--bg-2)",
            flexShrink: 0,
          }}
        >
          <ConnectorGlyph id={c} />
        </span>
      ))}
      {overflow > 0 && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "0 5px",
            height: 16,
            borderRadius: 8,
            background: "color-mix(in srgb, var(--accent-cool) 15%, transparent)",
            color: "var(--accent-cool)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0,
          }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
