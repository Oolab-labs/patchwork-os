import { StatusPill } from "@/components/patchwork";

/**
 * One column of the approval-policy permission grid (allow / ask /
 * deny). Pure presentational. Extracted from settings/page.tsx.
 */
export function PermColumn({
  tone,
  title,
  rules,
}: {
  tone: "ok" | "warn" | "err";
  title: string;
  rules: string[];
}) {
  // The bridge's cc-permissions payload can repeat a rule (the same
  // pattern arriving from both managed + project scope). Rendering
  // `key={rule}` then collides — React logs a duplicate-key error on
  // every re-render. Dedupe: a permission grid showing the same rule
  // twice is itself wrong, so collapsing is the correct fix.
  const uniqueRules = [...new Set(rules)];
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-2)",
        padding: 10,
        minHeight: 80,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}
      >
        <StatusPill tone={tone}>{title}</StatusPill>
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)" }}>
          {uniqueRules.length}
        </span>
      </div>
      {uniqueRules.length === 0 ? (
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)" }}>—</div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {uniqueRules.slice(0, 8).map((r) => (
            <li
              key={r}
              className="mono"
              style={{
                fontSize: "var(--fs-xs)",
                color: "var(--fg-1)",
                wordBreak: "break-all",
              }}
            >
              {r}
            </li>
          ))}
          {uniqueRules.length > 8 && (
            <li style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)" }}>
              +{uniqueRules.length - 8} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
