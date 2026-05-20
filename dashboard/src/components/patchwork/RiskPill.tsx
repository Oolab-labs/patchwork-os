export type RiskLevel = "low" | "medium" | "high";

const TONE: Record<RiskLevel, string> = {
  low: "chip-green",
  medium: "chip-amber",
  high: "chip-red",
};

export function RiskPill({ level, label }: { level: RiskLevel; label?: string }) {
  // The colored `.dot` is decorative (`aria-hidden`) — risk must never be
  // conveyed by colour alone (WCAG 1.4.1). Always render the visible text
  // label; `aria-label` spells out "risk" so the bare "LOW/MEDIUM/HIGH"
  // text isn't ambiguous out of context for screen-reader users.
  const text = label ?? level;
  return (
    <span
      className={`chip ${TONE[level]}`}
      aria-label={`${level} risk`}
      style={{
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-2xs)",
        fontWeight: 700,
      }}
    >
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}
