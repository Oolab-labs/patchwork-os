import Link from "next/link";
import { RiskPill, type RiskLevel } from "@/components/patchwork/RiskPill";
import { type EntityVariant, variantStyle } from "./types";

export interface ToolChipProps {
  name: string;
  tier?: RiskLevel;
  variant?: EntityVariant;
}

/**
 * <ToolChip> — linked identity chip for a tool name.
 *
 * Optional risk-tier pill (low / medium / high). Links into the insights
 * page filtered by tool so click-through lands on usage context.
 */
export function ToolChip({ name, tier, variant = "chip" }: ToolChipProps) {
  const { className, style } = variantStyle(variant);
  const ariaLabel = `Tool ${name}${tier ? `, ${tier} risk` : ""}`;
  return (
    <Link
      href={`/insights?tool=${encodeURIComponent(name)}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span style={{ fontFamily: "var(--font-mono)" }}>{name}</span>
      {tier && <RiskPill level={tier} />}
    </Link>
  );
}
