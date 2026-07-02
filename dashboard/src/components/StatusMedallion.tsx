import type { CSSProperties, ReactNode } from "react";

/**
 * The one dominant status object at the top of a redesigned page (recipe
 * detail, workers). A big colored medallion + a "Working fine" headline +
 * a verb-first sentence. Carries page state by color and size first, words
 * second — the non-technical operator should read it in one glance.
 *
 * Tone → traffic-light discipline: ok=green, warn=amber (waiting on you),
 * err=red (stopped), muted=grey/white (new / calm). `pulse` animates the
 * disc for a live "running now" state.
 */

export type MedallionTone = "ok" | "warn" | "err" | "muted";

interface StatusMedallionProps {
  tone: MedallionTone;
  /** Short headline, e.g. "Working fine", "Waiting on you", "Stopped". */
  title: string;
  /** The plain sentence under the headline. */
  children?: ReactNode;
  /** Animate the disc (a live "running now" state). */
  pulse?: boolean;
  size?: number;
  style?: CSSProperties;
}

const COLOR: Record<MedallionTone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  muted: "var(--ink-3)",
};

// A soft tint behind the disc so the color reads on both light and dark
// themes (flat fills wash out on the "paper" theme).
const TINT: Record<MedallionTone, string> = {
  ok: "color-mix(in srgb, var(--ok) 16%, transparent)",
  warn: "color-mix(in srgb, var(--warn) 18%, transparent)",
  err: "color-mix(in srgb, var(--err) 16%, transparent)",
  muted: "color-mix(in srgb, var(--ink-3) 14%, transparent)",
};

function Glyph({ tone }: { tone: MedallionTone }) {
  switch (tone) {
    case "ok":
      return (
        <path
          d="M6 11l3 3 5-6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    case "warn":
      return (
        <>
          <rect x="9" y="5.5" width="2" height="6" rx="1" fill="currentColor" />
          <circle cx="10" cy="14.5" r="1.15" fill="currentColor" />
        </>
      );
    case "err":
      return (
        <path
          d="M6.5 6.5l7 7M13.5 6.5l-7 7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      );
    case "muted":
      return <circle cx="10" cy="10" r="2.5" fill="currentColor" />;
  }
}

const TITLE_TONE_CLASS: Record<MedallionTone, string> = {
  ok: "ink-1",
  warn: "ink-1",
  err: "ink-1",
  muted: "ink-2",
};

export function StatusMedallion({
  tone,
  title,
  children,
  pulse = false,
  size = 44,
  style,
}: StatusMedallionProps) {
  const color = COLOR[tone];
  return (
    <div
      role="status"
      data-tone={tone}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: size,
          height: size,
          borderRadius: "50%",
          background: TINT[tone],
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color,
        }}
      >
        <svg
          width={size * 0.55}
          height={size * 0.55}
          viewBox="0 0 20 20"
          fill="none"
          style={
            pulse
              ? { animation: "pulse-dot 1.4s ease-in-out infinite" }
              : undefined
          }
        >
          <Glyph tone={tone} />
        </svg>
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--fs-xl)",
            fontWeight: 650,
            lineHeight: 1.15,
            color: `var(--${TITLE_TONE_CLASS[tone]})`,
          }}
        >
          {title}
        </div>
        {children != null && (
          <div
            style={{
              fontSize: "var(--fs-m)",
              color: "var(--ink-2)",
              lineHeight: 1.4,
              marginTop: 3,
            }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
