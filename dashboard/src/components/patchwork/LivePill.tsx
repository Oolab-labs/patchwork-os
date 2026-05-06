export function LivePill({ label = "live", tone = "accent" }: { label?: string; tone?: "accent" | "ok" | "muted" }) {
  const cls = tone === "ok" ? "chip-green" : tone === "muted" ? "chip-muted" : "chip-accent";
  return (
    <span
      className={`chip ${cls}`}
      style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", fontWeight: 600 }}
    >
      <span className="dot-live" aria-hidden="true" />
      {label}
    </span>
  );
}
