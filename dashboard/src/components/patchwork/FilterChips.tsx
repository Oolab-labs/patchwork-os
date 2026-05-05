import type { ReactNode } from "react";

export interface FilterOption<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: FilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="filter-chips" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={`filter-chip${opt.value === value ? " active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
          {typeof opt.count === "number" && (
            <span style={{ marginLeft: 4, opacity: 0.65, fontFamily: "var(--font-mono)" }}>({opt.count})</span>
          )}
        </button>
      ))}
    </div>
  );
}
