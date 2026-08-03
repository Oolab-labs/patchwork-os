"use client";

/**
 * The control boundary — what a worker may do now, what needs a person, and
 * what it may never do.
 *
 * This is the screen the product is sold on: everything before it, a chatbot
 * could fake. A list of proposed actions is just text. A statement about
 * *authority* — including one column that no approval can unlock — is not.
 *
 * Presentational only, deliberately. It renders what the bridge computed and
 * decides nothing itself. The bridge's `previewActions` evaluates candidates
 * through `decideWorkerAction`, the exact function enforcement uses, so a
 * column here cannot disagree with what would actually happen. If this
 * component ever grew its own rules, that guarantee would quietly die: a screen
 * that says "not permitted" while the gate would allow the action tells an
 * operator they are protected when they are not.
 *
 * So: no filtering, no re-bucketing, no inference from tool names. Render the
 * three lists as given.
 */

/** One evaluated action. Mirrors the bridge's `PreviewedAction` JSON shape. */
export interface BoundaryAction {
  label: string;
  toolName: string;
  classKey: string;
  /** Why it is in this column, in the gate's own words. */
  reason: string;
}

export interface ActionBoundary {
  mayDoNow: BoundaryAction[];
  needsApproval: BoundaryAction[];
  notPermitted: BoundaryAction[];
}

type ColumnKind = "ok" | "warn" | "err";

const COLUMNS: ReadonlyArray<{
  key: keyof ActionBoundary;
  kind: ColumnKind;
  title: string;
  sub: string;
  empty: string;
}> = [
  {
    key: "mayDoNow",
    kind: "ok",
    title: "May do now",
    sub: "No sign-off needed",
    empty: "Nothing flows without approval here.",
  },
  {
    key: "needsApproval",
    kind: "warn",
    title: "Needs approval",
    sub: "A named person must say yes",
    empty: "Nothing is waiting on a person.",
  },
  {
    key: "notPermitted",
    kind: "err",
    // Wording matters: "not permitted" and "no approval unlocks" say different
    // things, and only the second distinguishes this column from the middle one.
    title: "Not permitted",
    sub: "No approval can unlock these",
    empty: "Nothing is forbidden for this worker.",
  },
];

export default function ControlBoundary({
  boundary,
  workerName,
}: {
  boundary: ActionBoundary;
  workerName?: string;
}) {
  const total =
    boundary.mayDoNow.length +
    boundary.needsApproval.length +
    boundary.notPermitted.length;

  return (
    <section className="cb" aria-label="Control boundary">
      <header className="cb-head">
        <h3 className="cb-title">
          What {workerName ?? "this worker"} may do
        </h3>
        <span className="cb-count">
          {total} action{total === 1 ? "" : "s"} considered · evaluated before
          anything was attempted
        </span>
      </header>

      <div className="cb-cols">
        {COLUMNS.map((col) => {
          const items = boundary[col.key];
          return (
            <div key={col.key} className={`cb-col cb-col--${col.kind}`}>
              <header>
                <span className="cb-col-title">{col.title}</span>
                <span className="cb-col-sub">{col.sub}</span>
              </header>
              {items.length === 0 ? (
                <p className="cb-empty">{col.empty}</p>
              ) : (
                <ul>
                  {items.map((a) => (
                    <li key={`${a.toolName}:${a.classKey}:${a.label}`}>
                      <span className="cb-label">{a.label}</span>
                      <span className="cb-why">{a.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
