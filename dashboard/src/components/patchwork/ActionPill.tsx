import Link from "next/link";
import type { ReactNode } from "react";

export function ActionPill({
  children,
  icon,
  href,
  onClick,
  primary = false,
  type = "button",
  ariaLabel,
  disabled = false,
}: {
  children: ReactNode;
  icon?: ReactNode;
  href?: string;
  onClick?: () => void;
  primary?: boolean;
  type?: "button" | "submit";
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const cls = `btn sm${primary ? " primary" : " ghost"}`;
  const inner = (
    <>
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel} style={{ textDecoration: "none" }}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {inner}
    </button>
  );
}
