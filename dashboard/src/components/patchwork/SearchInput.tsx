"use client";
import type { ChangeEvent, CSSProperties } from "react";

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel,
  style,
  size = "md",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  style?: CSSProperties;
  size?: "sm" | "md";
}) {
  const h = size === "sm" ? 30 : 36;
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        height: h,
        padding: "0 12px",
        background: "var(--surface)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--r-m)",
        color: "var(--ink-2)",
        boxShadow: "var(--shadow-s)",
        ...style,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 0,
          background: "transparent",
          color: "var(--ink-0)",
          font: "inherit",
          fontSize: "var(--fs-m)",
        }}
      />
    </label>
  );
}
