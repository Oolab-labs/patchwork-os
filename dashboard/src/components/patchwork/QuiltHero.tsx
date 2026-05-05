import type { ReactNode } from "react";
import { QuiltBg } from "./QuiltBg";

export interface QuiltStat {
  label: ReactNode;
  value: ReactNode;
}

export function QuiltHero({
  greeting,
  headline,
  summary,
  stats,
  aside,
}: {
  greeting?: ReactNode;
  headline: ReactNode;
  summary?: ReactNode;
  stats?: QuiltStat[];
  aside?: ReactNode;
}) {
  return (
    <div className="quilt">
      <QuiltBg />
      <div className="quilt-content">
        {greeting && <div className="quilt-greeting">{greeting}</div>}
        <h1 className="quilt-title">{headline}</h1>
        {summary && <p className="quilt-summary">{summary}</p>}
        {stats && stats.length > 0 && (
          <div className="quilt-stats">
            {stats.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable static list
              <span key={i}>
                <b>{s.value}</b> {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {aside}
    </div>
  );
}
