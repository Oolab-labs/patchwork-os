/**
 * Cold-eyes judge verdict pill for a run step. Augment-only — a
 * `request_changes` verdict never gates the run; it surfaces the judge's
 * reasoning + suggested fixes inline on the run-detail step row.
 *
 * Lives in its own module (not the page file) so it can be imported by
 * both the page and its unit test — Next.js page files may only export
 * `default` + the framework's reserved names.
 */

export interface JudgeVerdict {
  verdict: "approve" | "request_changes" | "unparseable";
  reasons: string[];
  fixList?: string[];
  raw?: string;
}

function verdictPalette(
  verdict: JudgeVerdict["verdict"],
): { bg: string; fg: string; label: string } {
  if (verdict === "approve") {
    return { bg: "var(--ok-bg, #1b3a1b)", fg: "var(--ok)", label: "approve" };
  }
  if (verdict === "request_changes") {
    return {
      bg: "var(--warn-bg, #3a2a1b)",
      fg: "var(--warn, #d49a3a)",
      label: "request_changes",
    };
  }
  return {
    bg: "var(--bg-2)",
    fg: "var(--ink-2)",
    label: "unparseable",
  };
}

export function JudgeVerdictPill({ verdict }: { verdict: JudgeVerdict }) {
  const { bg, fg, label } = verdictPalette(verdict.verdict);
  const firstReason = verdict.reasons[0];
  const fixList = verdict.fixList?.filter((f) => f.trim().length > 0) ?? [];
  return (
    <div
      style={{
        marginTop: 4,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: "var(--fs-xs)",
            padding: "1px 6px",
            borderRadius: 3,
            background: bg,
            color: fg,
            letterSpacing: "0.02em",
          }}
          title="cold-eyes judge verdict (augment-only — never gates the run)"
        >
          judge: {label}
        </span>
        {firstReason && (
          <span
            className="muted"
            style={{
              fontSize: "var(--fs-xs)",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {firstReason}
            {verdict.reasons.length > 1 && (
              <> +{verdict.reasons.length - 1} more</>
            )}
          </span>
        )}
      </div>
      {fixList.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            paddingLeft: 8,
            borderLeft: "2px solid var(--line-2)",
          }}
        >
          <span
            className="mono muted"
            style={{ fontSize: "var(--fs-2xs)", letterSpacing: "0.02em" }}
          >
            suggested fixes
          </span>
          {fixList.map((fix, i) => (
            <span
              key={i}
              style={{
                fontSize: "var(--fs-xs)",
                whiteSpace: "normal",
                wordBreak: "break-word",
              }}
            >
              • {fix}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
