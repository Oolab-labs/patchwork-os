import type { CSSProperties, ReactNode } from "react";

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  /** Enable lift + glow on hover. Default: true */
  hover?: boolean;
  /**
   * Inner padding as a CSS value, e.g. "20px" or "var(--s-5)".
   * Pass empty string "" to suppress padding (manage it yourself).
   * Default: "var(--s-5)"
   */
  padding?: string;
  style?: CSSProperties;
  title?: string;
}

export function GlassCard({
  children,
  className = "",
  hover = true,
  padding = "var(--s-5)",
  style,
  title,
}: GlassCardProps) {
  const classes = [
    "glass-card",
    hover ? "glass-card--hover" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const merged: CSSProperties = padding
    ? { padding, ...style }
    : { ...style };

  return (
    <div className={classes} style={merged} title={title}>
      {children}
    </div>
  );
}
