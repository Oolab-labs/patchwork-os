/**
 * LivePill — small status chip in the same visual register as `chip` /
 * `chip-{tone}`. Two callable shapes:
 *
 *   <LivePill label="5s" tone="muted" />        — generic label + tone
 *   <LivePill connection="live" />              — connection-state preset
 *
 * Use `connection` for SSE / live-stream health on Activity / Approvals /
 * elsewhere — it maps to label + tone + dot animation so every page agrees
 * on what "Live", "Reconnecting…", and "Offline" look like. Passing
 * `connection` overrides any `label`/`tone` also provided.
 */

export type LivePillConnection = "live" | "reconnecting" | "offline";

const CONNECTION_PRESETS: Record<
  LivePillConnection,
  { label: string; tone: "ok" | "muted" | "accent"; pulse: boolean }
> = {
  live: { label: "Live", tone: "ok", pulse: true },
  reconnecting: { label: "Reconnecting…", tone: "accent", pulse: true },
  offline: { label: "Offline", tone: "muted", pulse: false },
};

export function LivePill({
  label = "live",
  tone = "accent",
  connection,
}: {
  label?: string;
  tone?: "accent" | "ok" | "muted";
  connection?: LivePillConnection;
}) {
  const resolved = connection
    ? CONNECTION_PRESETS[connection]
    : { label, tone, pulse: true };
  const cls =
    resolved.tone === "ok"
      ? "chip-green"
      : resolved.tone === "muted"
        ? "chip-muted"
        : "chip-accent";
  return (
    <span
      className={`chip ${cls}`}
      aria-live={connection ? "polite" : undefined}
      style={{
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-2xs)",
        fontWeight: 600,
      }}
    >
      <span
        className={resolved.pulse ? "dot-live" : undefined}
        aria-hidden="true"
        style={
          resolved.pulse
            ? undefined
            : {
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "currentColor",
                opacity: 0.6,
                display: "inline-block",
                marginRight: 6,
              }
        }
      />
      {resolved.label}
    </span>
  );
}
