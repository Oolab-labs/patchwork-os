import type { ReactNode } from "react";

export type StatusTone =
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "accent"
  | "muted"
  | "purple";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "chip-green",
  warn: "chip-amber",
  err: "chip-red",
  info: "chip-blue",
  accent: "chip-accent",
  muted: "chip-muted",
  purple: "chip-purple",
};

export function StatusPill({
  tone = "muted",
  dot = false,
  children,
  className,
}: {
  tone?: StatusTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const cls = `chip ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`;
  return (
    <span className={cls}>
      {dot && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
