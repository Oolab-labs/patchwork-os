export interface HBarItem {
  label: string;
  value: number;
  color?: string;
  sub?: string;
}

export function HBarList({
  items,
  max,
  height = 6,
  showValues = true,
}: {
  items: HBarItem[];
  max?: number;
  height?: number;
  showValues?: boolean;
}) {
  const m = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "center", gap: 8 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-xs)",
                  color: "var(--ink-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </span>
              {item.sub && (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", color: "var(--ink-3)" }}>
                  {item.sub}
                </span>
              )}
            </div>
            <div style={{ height, background: "var(--line-3)", borderRadius: height }}>
              <div
                style={{
                  width: `${Math.max(2, (item.value / m) * 100)}%`,
                  height: "100%",
                  background: item.color ?? "var(--orange)",
                  borderRadius: height,
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          </div>
          {showValues && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
                color: "var(--ink-2)",
                textAlign: "right",
                minWidth: 36,
              }}
            >
              {item.value.toLocaleString()}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
