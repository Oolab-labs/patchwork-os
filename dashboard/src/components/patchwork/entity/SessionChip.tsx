import Link from "next/link";
import { LivePill } from "@/components/patchwork/LivePill";
import { type EntityVariant, variantStyle } from "./types";

export interface SessionChipProps {
  id: string;
  active?: boolean;
  variant?: EntityVariant;
}

/**
 * <SessionChip> — linked identity chip for a Claude session.
 *
 * Renders only the first 8 chars of the id to keep the chip compact;
 * full id remains in the link target + aria-label.
 */
export function SessionChip({
  id,
  active,
  variant = "chip",
}: SessionChipProps) {
  const { className, style } = variantStyle(variant);
  const short = id.slice(0, 8);
  const ariaLabel = `Session ${id}${active ? ", active" : ""}`;
  return (
    <Link
      href={`/sessions/${encodeURIComponent(id)}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span style={{ fontFamily: "var(--font-mono)" }}>{short}</span>
      {active && <LivePill connection="live" />}
    </Link>
  );
}
