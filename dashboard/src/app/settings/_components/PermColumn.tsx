import { StatusPill } from "@/components/patchwork";

/**
 * One column of the approval-policy permission grid (allow / ask /
 * deny). Pure presentational. Extracted from settings/page.tsx.
 */
export function PermColumn({
  tone,
  title,
  rules,
}: {
  tone: "ok" | "warn" | "err";
  title: string;
  rules: string[];
}) {
  // The bridge's cc-permissions payload can repeat a rule (the same
  // pattern arriving from both managed + project scope). Rendering
  // `key={rule}` then collides — React logs a duplicate-key error on
  // every re-render. Dedupe: a permission grid showing the same rule
  // twice is itself wrong, so collapsing is the correct fix.
  const uniqueRules = [...new Set(rules)];
  return (
    <div className="perm-col">
      <div className="perm-col-head">
        <StatusPill tone={tone}>{title}</StatusPill>
        <span className="perm-col-count">{uniqueRules.length}</span>
      </div>
      {uniqueRules.length === 0 ? (
        <div className="perm-col-empty">—</div>
      ) : (
        <ul className="perm-col-list">
          {uniqueRules.slice(0, 8).map((r) => (
            <li key={r} className="mono perm-col-item">
              {r}
            </li>
          ))}
          {uniqueRules.length > 8 && (
            <li className="perm-col-more">
              +{uniqueRules.length - 8} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
