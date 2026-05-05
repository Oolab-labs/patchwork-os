import type { CSSProperties, ReactNode } from "react";

export function PatchCard({
  children,
  beam = false,
  className,
  style,
  padded = true,
}: {
  children: ReactNode;
  beam?: boolean;
  className?: string;
  style?: CSSProperties;
  padded?: boolean;
}) {
  const cls = `card${beam ? " beam" : ""}${className ? ` ${className}` : ""}`;
  const merged: CSSProperties = padded ? { ...style } : { padding: 0, ...style };
  return (
    <div className={cls} style={merged}>
      {children}
    </div>
  );
}
