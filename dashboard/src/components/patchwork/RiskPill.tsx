export type RiskLevel = "low" | "medium" | "high";

const TONE: Record<RiskLevel, string> = {
  low: "chip-green",
  medium: "chip-amber",
  high: "chip-red",
};

export function RiskPill({ level, label }: { level: RiskLevel; label?: string }) {
  return (
    <span
      className={`chip ${TONE[level]}`}
      style={{
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-2xs)",
        fontWeight: 700,
      }}
    >
      <span className="dot" aria-hidden="true" />
      {label ?? level}
    </span>
  );
}
