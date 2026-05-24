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
      className="toggle-row"
      data-disabled={String(!!disabled)}
      title={disabled ? disabledReason : undefined}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} className="toggle-row-body">
        <div className="toggle-row-label">{label}</div>
        <div className="toggle-row-help">
          {help}
          {disabled && disabledReason ? (
            <div className="toggle-row-reason">ⓘ {disabledReason}</div>
          ) : null}
        </div>
      </label>
    </div>
  );
}
