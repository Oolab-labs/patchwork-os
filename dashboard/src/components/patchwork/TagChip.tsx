import type { ReactNode } from "react";

export function TagChip({
  children,
  mono = true,
  tone = "muted",
}: {
  children: ReactNode;
  mono?: boolean;
  tone?: "muted" | "accent" | "info" | "ok" | "warn" | "err";
}) {
  const cls =
    tone === "accent"
      ? "chip-accent"
      : tone === "info"
      ? "chip-blue"
      : tone === "ok"
      ? "chip-green"
      : tone === "warn"
      ? "chip-amber"
      : tone === "err"
      ? "chip-red"
      : "chip-muted";
  return (
    <span
      className={`chip ${cls}`}
      style={{ fontFamily: mono ? "var(--font-mono)" : undefined, fontSize: 10.5, padding: "2px 7px" }}
    >
      {children}
    </span>
  );
}
