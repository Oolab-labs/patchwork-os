import type { CSSProperties } from "react";

export type DotTone = "ok" | "warn" | "err" | "info" | "accent" | "muted";

const TONE_VAR: Record<DotTone, string> = {
  ok: "var(--green)",
  warn: "var(--amber)",
  err: "var(--red)",
  info: "var(--blue)",
  accent: "var(--orange)",
  muted: "var(--ink-3)",
};

export function StatusDot({
  tone = "muted",
  pulse = false,
  size = 7,
}: {
  tone?: DotTone;
  pulse?: boolean;
  size?: number;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: TONE_VAR[tone],
    display: "inline-block",
    flexShrink: 0,
  };
  return <span aria-hidden="true" className={pulse ? "dot-live" : undefined} style={style} />;
}
