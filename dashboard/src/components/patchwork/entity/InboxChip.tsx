import Link from "next/link";
import { inboxItemKey } from "@/lib/entityKey";
import { type EntityVariant, variantStyle } from "./types";

export interface InboxChipProps {
  name: string;
  recipeName?: string;
  variant?: EntityVariant;
}

/**
 * <InboxChip> — linked identity chip for an inbox item.
 *
 * The visible label keeps the date in it (inbox identity includes the
 * date — see `inboxItemKey`); only the `.md` suffix is stripped for
 * the link target.
 */
export function InboxChip({
  name,
  recipeName,
  variant = "chip",
}: InboxChipProps) {
  const { className, style } = variantStyle(variant);
  const key = inboxItemKey(name);
  const ariaLabel = `Inbox ${key}${recipeName ? ` (${recipeName})` : ""}`;
  return (
    <Link
      href={`/inbox?item=${encodeURIComponent(key)}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span>{key}</span>
    </Link>
  );
}
