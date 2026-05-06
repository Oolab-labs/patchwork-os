import { RiskPill, type RiskLevel } from "@/components/patchwork";

export function RiskMeter({ level }: { level: "low" | "medium" | "high" }) {
  const filled = level === "high" ? 4 : level === "medium" ? 3 : 2;
  const color = level === "high" ? "var(--red)" : level === "medium" ? "var(--amber)" : "var(--green)";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }} aria-label={`${level} risk`}>
      <span style={{ display: "inline-flex", gap: 2 }} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              width: 10,
              height: 6,
              borderRadius: 1,
              background: i < filled ? color : "var(--line-2)",
            }}
          />
        ))}
      </span>
      <RiskPill level={level as RiskLevel} label={level.toUpperCase()} />
    </div>
  );
}
