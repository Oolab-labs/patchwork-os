import type { CSSProperties } from "react";

/**
 * "Worked 9 of last 10 times" as dots — the redesign's replacement for the
 * bare "success rate 90%" stat. Meaning first (the sentence), number as a
 * dot strip, never a naked percentage.
 *
 * Renders the most recent `max` outcomes as filled (good, green) or hollow
 * (not-good, muted) dots. `good` is clamped to `[0, shown]`. When there's
 * no history yet it renders nothing (callers show a "new" state instead).
 */

interface DotStripProps {
  /** Number of good outcomes among the shown window. */
  good: number;
  /** Total outcomes observed. */
  total: number;
  /** Max dots to render (the "last N"). Default 10. */
  max?: number;
  /** Prefix the dots with the plain "Worked N of last M times" sentence. */
  withSentence?: boolean;
  style?: CSSProperties;
}

/** The plain sentence form, exported so headers can use it without dots. */
export function workedSentence(good: number, total: number, max = 10): string {
  const shown = Math.min(total, max);
  const g = Math.max(0, Math.min(good, shown));
  if (shown === 0) return "No runs yet";
  if (shown === 1) return g === 1 ? "Worked the one time it ran" : "Didn't work the one time it ran";
  return `Worked ${g} of last ${shown} times`;
}

export function DotStrip({ good, total, max = 10, withSentence = false, style }: DotStripProps) {
  const shown = Math.min(total, max);
  if (shown === 0) return null;
  const g = Math.max(0, Math.min(good, shown));
  const dots = Array.from({ length: shown }, (_, i) => i < g);
  const label = workedSentence(good, total, max);

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}
      role="img"
      aria-label={label}
    >
      {withSentence && (
        <span style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)" }}>{label}</span>
      )}
      <span aria-hidden="true" style={{ display: "inline-flex", gap: 3 }}>
        {dots.map((isGood, i) => (
          <span
            // Fixed-length ordered strip; index is a stable key here.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional dots
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: isGood ? "var(--ok)" : "transparent",
              border: isGood
                ? "1px solid var(--ok)"
                : "1px solid color-mix(in srgb, var(--ink-3) 60%, transparent)",
            }}
          />
        ))}
      </span>
    </span>
  );
}
