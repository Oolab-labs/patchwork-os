import { type EntityVariant, variantStyle } from "./types";

export interface ConnectorChipProps {
  id: string;
  healthy?: boolean;
  variant?: EntityVariant;
}

/**
 * <ConnectorChip> — linked identity chip for a connector.
 *
 * Target is a hash anchor on `/connections` (the connections page
 * scrolls to the matching row), so this renders a plain `<a>` instead
 * of a Next `<Link>` — Next's router would strip the fragment.
 *
 * Health is signalled by a coloured dot AND an explicit text label on
 * aria so colour is never the sole signal.
 */
export function ConnectorChip({
  id,
  healthy,
  variant = "chip",
}: ConnectorChipProps) {
  const { className, style } = variantStyle(variant);
  const dotColor =
    healthy === undefined
      ? "var(--muted, #888)"
      : healthy
        ? "var(--green, #2ea44f)"
        : "var(--red, #d1242f)";
  const healthLabel =
    healthy === undefined ? "" : healthy ? ", healthy" : ", unhealthy";
  const ariaLabel = `Connector ${id}${healthLabel}`;
  return (
    <a
      href={`/connections#${id}`}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          display: "inline-block",
        }}
      />
      <span>{id}</span>
      {healthy !== undefined && (
        <span className="sr-only">{healthy ? "healthy" : "unhealthy"}</span>
      )}
    </a>
  );
}
