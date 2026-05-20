import Link from "next/link";
import { type EntityVariant, variantStyle } from "./types";

export interface TraceChipProps {
  /**
   * Trace identity key. Named `traceKey` (not `key`) because React
   * silently consumes any prop literally called `key` — passing it
   * through would arrive as `undefined`.
   */
  traceKey: string;
  traceType: string;
  variant?: EntityVariant;
}

/**
 * Glyph per trace-type so each kind has a single-character visual hook
 * — keeps the chip compact in dense lists. Unknown types fall back to a
 * generic dot.
 */
const TYPE_GLYPH: Record<string, string> = {
  approval: "✓",
  enrichment: "✎",
  recipe: "▶",
  agent: "◆",
  decision: "●",
};

function glyphFor(traceType: string): string {
  return TYPE_GLYPH[traceType] ?? "·";
}

/**
 * <TraceChip> — linked identity chip for a stored decision trace.
 *
 * Renders a type glyph + short key. Click-through lands on the traces
 * page filtered by the trace's key.
 */
export function TraceChip({
  traceKey,
  traceType,
  variant = "chip",
}: TraceChipProps) {
  const { className, style } = variantStyle(variant);
  const short = traceKey.length > 24 ? `${traceKey.slice(0, 24)}…` : traceKey;
  const ariaLabel = `Trace ${traceType} ${traceKey}`;
  return (
    <Link
      href={`/traces?q=${encodeURIComponent(traceKey)}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span aria-hidden="true">{glyphFor(traceType)}</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{short}</span>
    </Link>
  );
}
