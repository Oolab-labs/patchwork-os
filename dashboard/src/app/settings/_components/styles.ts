/**
 * Shared inline-style objects for the settings page + its extracted
 * sections. Plain data — kept in one place so every section renders
 * inputs / labels / help-text consistently.
 *
 * These intentionally use the canonical --ink and --line tokens, not
 * the legacy --fg and --border aliases. The aliases stay in
 * globals.css for back-compat but new surfaces pick the canonical
 * names.
 */
export const inputStyle = {
  background: "var(--recess)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2)",
  color: "var(--ink-0)",
  fontSize: "var(--fs-m)",
  fontFamily: "var(--font-mono)",
  padding: "6px 10px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

export const labelStyle = {
  display: "block",
  fontSize: "var(--fs-m)",
  color: "var(--ink-1)",
  marginBottom: 4,
  fontWeight: 500,
};

export const helpStyle = {
  fontSize: "var(--fs-s)",
  color: "var(--ink-2)",
  margin: "4px 0 0",
  lineHeight: 1.5,
};
