/**
 * Checkbox + label + help-text row used throughout the settings page.
 *
 * Pure presentational — no settings state coupling. Extracted from
 * settings/page.tsx as the first slice of the page split (the page is
 * 2000+ lines; sections are being pulled into _components/).
 */
export function ToggleRow({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /**
   * When true, the checkbox cannot be toggled by the user. Used by
   * the kill-switch row when env-locked (#422 v2-I7).
   */
  disabled?: boolean;
  /** Tooltip text shown on hover when disabled is true. */
  disabledReason?: string;
}) {
  return (
    <div
      style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
      title={disabled ? disabledReason : undefined}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, cursor: disabled ? "not-allowed" : undefined }}
      />
      <label
        htmlFor={id}
        style={{ flex: 1, cursor: disabled ? "not-allowed" : "pointer" }}
      >
        <div
          style={{
            fontSize: "var(--fs-m)",
            fontWeight: 500,
            color: disabled ? "var(--fg-2)" : "var(--fg-0)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: "var(--fs-s)",
            color: "var(--fg-2)",
            marginTop: 2,
            lineHeight: 1.5,
          }}
        >
          {help}
          {disabled && disabledReason ? (
            <div
              style={{
                marginTop: 4,
                fontSize: "var(--fs-xs)",
                color: "var(--fg-3)",
                fontStyle: "italic",
              }}
            >
              ⓘ {disabledReason}
            </div>
          ) : null}
        </div>
      </label>
    </div>
  );
}
