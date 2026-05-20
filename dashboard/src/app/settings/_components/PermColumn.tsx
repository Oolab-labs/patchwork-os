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
          {rules.length}
        </span>
      </div>
      {rules.length === 0 ? (
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
          {rules.slice(0, 8).map((r) => (
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
          {rules.length > 8 && (
            <li style={{ fontSize: "var(--fs-xs)", color: "var(--fg-3)" }}>
              +{rules.length - 8} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
