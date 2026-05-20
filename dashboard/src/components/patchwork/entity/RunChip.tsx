import Link from "next/link";
import { StatusPill, deriveRunStatus } from "@/components/patchwork/StatusPill";
import { type EntityVariant, variantStyle } from "./types";

export type RunStatus = "running" | "done" | "error" | string;

export interface RunChipProps {
  seq: number;
  status?: RunStatus;
  hadStepErrors?: boolean;
  recipeName?: string;
  variant?: EntityVariant;
}

/**
 * <RunChip> — linked identity chip for a single recipe run.
 *
 * Renders `#<seq>` and, when `status` is provided, an inner StatusPill
 * derived via `deriveRunStatus()` so the same verdict shows up wherever
 * a run is referenced. Always a real <Link>, so keyboard nav + middle-
 * click open in tab work without extra wiring at the call site.
 */
export function RunChip({
  seq,
  status,
  hadStepErrors,
  recipeName,
  variant = "chip",
}: RunChipProps) {
  const { className, style } = variantStyle(variant);
  const derived = status
    ? deriveRunStatus(status, { hadStepErrors })
    : undefined;
  const label = `#${seq}`;
  const ariaLabel = derived
    ? `Run ${label}${recipeName ? ` (${recipeName})` : ""}, ${derived.label}`
    : `Run ${label}${recipeName ? ` (${recipeName})` : ""}`;
  return (
    <Link
      href={`/runs/${seq}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span style={{ fontFamily: "var(--font-mono)" }}>{label}</span>
      {derived && (
        <StatusPill tone={derived.tone} srLabel={derived.label}>
          {derived.label}
        </StatusPill>
      )}
    </Link>
  );
}
