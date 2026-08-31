/**
 * Can Patchwork prove the evidence relationships it claims should exist?
 *
 * `evidenceCoverage` answers a flatter question — how many rows carry a
 * correlation id — and that question stops being the useful one as soon as the
 * ledgers start joining. A row without a run reference is not automatically a
 * gap, and a row with one is not automatically connected. Three facts from the
 * live ledgers, each of which breaks the flat reading:
 *
 *  1. Six approval requests carry no correlation id and every one is CORRECT:
 *     they are MCP client-session tool calls that never belonged to a run. Two
 *     of the four paths into the queue have no run by construction.
 *  2. Seven `privacy_shadow` rows at `rv:1` carry no correlation id, and they
 *     are orchestrator task dispatches (`claudeOrchestrator.ts`), not recipe
 *     steps. Same shape, different ledger.
 *  3. `runs.jsonl` is an EVENT log: 974 rows resolve to 505 distinct `taskId`s.
 *     Anything counted over raw rows double-counts a healthy run.
 *
 * So the unit here is a RELATIONSHIP with an expectation attached, not a field.
 * For each row: was this row supposed to reach a run at all, and if so, does the
 * path resolve?
 *
 * ## The states, and why five rather than two
 *
 *  - `connected`      — the expected path resolves.
 *  - `legacy`         — the row predates the version that promises the link.
 *  - `notApplicable`  — the row was never supposed to have one (see 1 and 2).
 *  - `unresolved`     — the link names a target that cannot be found.
 *  - `defect`         — the writer should have supplied a usable link and did not.
 *
 * Collapsing `legacy` or `notApplicable` into `defect` is what makes a coverage
 * number permanently red, and a permanently-red number is one nobody reads. The
 * distinction is the whole point: six missing correlation ids sound broken until
 * you establish that all six are client-session calls.
 *
 * `unresolved` is deliberately NOT folded into `defect` either. "The evidence
 * named a run and the run is gone" is a different fact from "the writer never
 * wrote one", and the difference will matter more once retention exists — an
 * aged-out target is governance working as configured, not a broken chain.
 *
 * ## Integrity
 *
 *   integrity = connected / (connected + defect + unresolved)
 *
 * Legacy and not-applicable rows are counted and shown, and excluded from the
 * denominator. Scoring against every row ever written would let history make a
 * healthy system look broken forever.
 *
 * ## Counts only, never contents
 *
 * Same rule as `evidenceCoverage`: a correlation id IS a run's `taskId`, so
 * nothing here returns a row, an id or any value — only counts and names.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { patchworkHome } from "./patchworkHome.js";

export type RelationState =
  | "connected"
  | "legacy"
  | "notApplicable"
  | "unresolved"
  | "defect";

export interface RelationshipCoverage {
  /** e.g. "gate decision → run". */
  name: string;
  /** One line an operator can act on when this relationship is not clean. */
  note: string;
  connected: number;
  legacy: number;
  notApplicable: number;
  unresolved: number;
  defect: number;
  /** `connected / (connected + defect + unresolved)`; null when nothing expected. */
  integrity: number | null;
}

export interface EvidenceRelationships {
  dir: string;
  relationships: RelationshipCoverage[];
  /** Distinct `taskId`s after collapsing the run event log. */
  distinctRuns: number;
  /** Raw rows in `runs.jsonl`, kept so the collapse is visible rather than implied. */
  runRows: number;
  /** Rows that would not parse, per file. Reported, never silently skipped. */
  corrupt: number;
}

type Row = Record<string, unknown>;

function readRows(dir: string, file: string): { rows: Row[]; corrupt: number } {
  const full = path.join(dir, file);
  if (!existsSync(full)) return { rows: [], corrupt: 0 };
  let text: string;
  try {
    text = readFileSync(full, "utf-8");
  } catch {
    return { rows: [], corrupt: 1 };
  }
  const rows: Row[] = [];
  let corrupt = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as Row);
    } catch {
      corrupt++;
    }
  }
  return { rows, corrupt };
}

const str = (r: Row, k: string): string | undefined =>
  typeof r[k] === "string" && r[k] !== "" ? (r[k] as string) : undefined;
const num = (r: Row, k: string): number | undefined =>
  typeof r[k] === "number" && Number.isFinite(r[k])
    ? (r[k] as number)
    : undefined;

/**
 * Collapse the run event log to the set of distinct `taskId`s.
 *
 * `runs.jsonl` writes a `running` row and then a terminal row for the same run,
 * so the raw row count is ~2x the number of runs. A coverage denominator over
 * rows would count a healthy run twice and drift as the ratio changes.
 */
function runIds(dir: string): { ids: Set<string>; rows: number } {
  // Reads the rotation archive alongside the live file, for the same reason
  // trust replay does (#1337): `runs.jsonl` is capped by BYTES, so a run can
  // rotate out while the evidence that names it is still current. Ignoring the
  // archive would report a healthy join as `unresolved` purely because the log
  // grew.
  const live = readRows(dir, "runs.jsonl");
  const archived = readRows(dir, "runs.jsonl.1");
  const ids = new Set<string>();
  for (const r of [...live.rows, ...archived.rows]) {
    const t = str(r, "taskId");
    if (t) ids.add(t);
  }
  return { ids, rows: live.rows.length + archived.rows.length };
}

function tally(
  name: string,
  note: string,
  items: Array<{ state: RelationState }>,
): RelationshipCoverage {
  const c = {
    connected: 0,
    legacy: 0,
    notApplicable: 0,
    unresolved: 0,
    defect: 0,
  };
  for (const i of items) c[i.state]++;
  const denom = c.connected + c.defect + c.unresolved;
  return {
    name,
    note,
    ...c,
    integrity: denom === 0 ? null : c.connected / denom,
  };
}

/**
 * Classify a row whose link should point at a run.
 *
 * `expected` is decided by the CALLER, because whether a run was ever in scope
 * is a property of the writing path and not of the row's shape.
 */
function toRun(
  row: Row,
  field: string,
  expected: "yes" | "legacy" | "notApplicable",
  runs: Set<string>,
): { state: RelationState } {
  if (expected === "legacy") return { state: "legacy" };
  if (expected === "notApplicable") return { state: "notApplicable" };
  const id = str(row, field);
  if (!id) return { state: "defect" };
  return { state: runs.has(id) ? "connected" : "unresolved" };
}

export function evidenceRelationships(
  dir = patchworkHome(),
): EvidenceRelationships {
  const { ids: runs, rows: runRows } = runIds(dir);
  let corrupt = 0;

  const gate = readRows(dir, "worker_gate_decisions.jsonl");
  const receipts = readRows(dir, "boundary_receipts.jsonl");
  const shadow = readRows(dir, "privacy_shadow.jsonl");
  const appr = readRows(dir, "approval_log.jsonl");
  corrupt += gate.corrupt + receipts.corrupt + shadow.corrupt + appr.corrupt;

  const rel: RelationshipCoverage[] = [];

  // --- gate decisions -----------------------------------------------------
  // Every gate decision happens inside a run — `buildWorkerAutonomyGate` is
  // wired from one site — so at rv>=1 there is no legitimate "had no run".
  rel.push(
    tally(
      "gate decision → run",
      "a decision at rv>=1 with no run reference is a writer defect: every gate decision happens inside a run",
      gate.rows.map((r) =>
        toRun(
          r,
          "correlationId",
          (num(r, "rv") ?? 0) >= 1 ? "yes" : "legacy",
          runs,
        ),
      ),
    ),
  );
  rel.push(
    tally(
      "gate decision → rule",
      "at rv>=2 every decision names the rule that decided it; absence is a writer defect",
      gate.rows.map((r) => {
        if ((num(r, "rv") ?? 0) < 2) return { state: "legacy" as const };
        return {
          state: str(r, "ruleId")
            ? ("connected" as const)
            : ("defect" as const),
        };
      }),
    ),
  );

  // --- boundary receipts --------------------------------------------------
  rel.push(
    tally(
      "boundary receipt → run",
      "receipts are written from a dispatch that always has a run id in scope",
      receipts.rows.map((r) =>
        toRun(
          r,
          "correlationId",
          (num(r, "rv") ?? 0) >= 1 ? "yes" : "legacy",
          runs,
        ),
      ),
    ),
  );

  // --- privacy shadow -----------------------------------------------------
  // Source-aware: a shadow row from the ORCHESTRATOR path is a task dispatch,
  // not a recipe step, and has no run by construction. `recipeName` is the
  // discriminator — the recipe path always sets it.
  rel.push(
    tally(
      "privacy shadow → run",
      "orchestrator dispatches legitimately have no run; only recipe-step rows are expected to join",
      shadow.rows.map((r) =>
        toRun(
          r,
          "correlationId",
          (num(r, "rv") ?? 0) < 1
            ? "legacy"
            : str(r, "recipeName")
              ? "yes"
              : "notApplicable",
          runs,
        ),
      ),
    ),
  );

  // --- approvals ----------------------------------------------------------
  // Source-aware again: two of the four paths into the queue are MCP
  // client-session tool calls with no run. `sessionId` is the discriminator.
  const requests = appr.rows.filter((r) => str(r, "kind") === "request");
  const requestIds = new Set(
    requests.map((r) => str(r, "callId")).filter((v): v is string => !!v),
  );
  rel.push(
    tally(
      "approval request → run",
      "client-session (MCP) approvals never belonged to a run; only recipe/worker requests are expected to join",
      requests.map((r) => {
        const s = str(r, "sessionId") ?? "";
        const fromRun = s.startsWith("recipe") || s.startsWith("worker:");
        return toRun(
          r,
          "correlationId",
          (num(r, "rv") ?? 0) < 1
            ? "legacy"
            : fromRun
              ? "yes"
              : "notApplicable",
          runs,
        );
      }),
    ),
  );

  // Two-hop: a decision reaches its run THROUGH its request. Scoring decision
  // rows by looking for a run id directly would mark every one of them broken.
  for (const kind of ["decision", "attribution"] as const) {
    const rows = appr.rows.filter((r) => str(r, "kind") === kind);
    rel.push(
      tally(
        `approval ${kind} → request`,
        `a ${kind} reaches its run through its request; a callId with no request is a broken chain`,
        rows.map((r) => {
          const cid = str(r, "callId");
          if (!cid) return { state: "defect" as const };
          return {
            state: requestIds.has(cid)
              ? ("connected" as const)
              : ("unresolved" as const),
          };
        }),
      ),
    );
  }

  return { dir, relationships: rel, distinctRuns: runs.size, runRows, corrupt };
}

/**
 * Render for a human.
 *
 * Leads with the raw counts and puts the percentage last, for the same reason
 * `evidenceCoverage` leads with the denominator: "98%" reads as a verdict,
 * "59 connected · 1 defect" is the fact someone can act on.
 */
export function formatEvidenceRelationships(r: EvidenceRelationships): string {
  const L: string[] = [];
  L.push("[evidence] can the expected relationships be traversed?");
  L.push(
    `  ${r.runRows} run rows collapse to ${r.distinctRuns} distinct run(s)` +
      (r.corrupt > 0 ? `  ·  ${r.corrupt} unparseable line(s)` : ""),
  );
  L.push("");
  const w = Math.max(...r.relationships.map((x) => x.name.length));
  L.push(
    `  ${"relationship".padEnd(w)}   conn  legacy   n/a  unres  defect   integrity`,
  );
  for (const x of r.relationships) {
    const pct =
      x.integrity === null
        ? "     —"
        : `${(x.integrity * 100).toFixed(1)}%`.padStart(6);
    L.push(
      `  ${x.name.padEnd(w)}  ${String(x.connected).padStart(5)}` +
        `  ${String(x.legacy).padStart(6)}` +
        `  ${String(x.notApplicable).padStart(4)}` +
        `  ${String(x.unresolved).padStart(5)}` +
        `  ${String(x.defect).padStart(6)}   ${pct}`,
    );
  }
  L.push("");
  const broken = r.relationships.filter(
    (x) => x.defect > 0 || x.unresolved > 0,
  );
  if (broken.length === 0) {
    L.push(
      "  No defects and nothing unresolved — every expected link resolves.",
    );
    L.push(
      "  `legacy` and `n/a` are counted above and excluded from integrity on purpose:",
    );
    L.push(
      "  history and rows that never owed a link must not make a healthy system look broken.",
    );
  } else {
    // Name what broke, not a percentage. A number tells you something is wrong;
    // a sentence tells you what to go and look at.
    for (const x of broken) {
      if (x.defect > 0) {
        L.push(`  ${x.defect} × ${x.name}: link never written — ${x.note}`);
      }
      if (x.unresolved > 0) {
        L.push(
          `  ${x.unresolved} × ${x.name}: link names a target that cannot be found`,
        );
      }
    }
  }
  L.push("");
  return `${L.join("\n")}\n`;
}
