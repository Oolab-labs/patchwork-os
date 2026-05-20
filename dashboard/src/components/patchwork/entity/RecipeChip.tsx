import Link from "next/link";
import { LivePill } from "@/components/patchwork/LivePill";
import { canonicalRecipeKey } from "@/lib/entityKey";
import { type EntityVariant, variantStyle } from "./types";

export interface RecipeChipProps {
  name: string;
  trigger?: string;
  live?: boolean;
  variant?: EntityVariant;
}

/**
 * <RecipeChip> — linked identity chip for a recipe.
 *
 * Always routes through `canonicalRecipeKey()` so the same recipe lands
 * on the same URL regardless of whether the source string carried a
 * trailing agent-axis suffix.
 */
export function RecipeChip({
  name,
  trigger,
  live,
  variant = "chip",
}: RecipeChipProps) {
  const { className, style } = variantStyle(variant);
  const key = canonicalRecipeKey(name);
  const ariaLabel = `Recipe ${key}${trigger ? ` (${trigger})` : ""}${
    live ? ", live" : ""
  }`;
  return (
    <Link
      href={`/recipes/${key}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span>{key}</span>
      {live && <LivePill connection="live" />}
    </Link>
  );
}
