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
    <ul role="list" style={{ display: "flex", flexDirection: "column", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
      {items.map((item) => {
        const pct = Math.round((item.value / m) * 100);
        return (
          <li key={item.label} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "center", gap: 8 }}>
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
              <div
                role="progressbar"
                aria-label={`${item.label}: ${item.value.toLocaleString()} (${pct}%)`}
                aria-valuenow={item.value}
                aria-valuemin={0}
                aria-valuemax={m}
                style={{ height, background: "var(--line-3)", borderRadius: height }}
              >
                <div
                  style={{
                    width: `${Math.max(2, pct)}%`,
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
                aria-hidden="true"
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
          </li>
        );
      })}
    </ul>
  );
}
