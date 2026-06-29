/**
 * Considered-approval KPI — the lens that tells you whether delegated trust is
 * being earned HONESTLY or rubber-stamped.
 *
 * The worker trust dial answers "how high has the level climbed". It does NOT
 * answer the question the thesis actually rests on: are the approvals behind
 * that climb *considered*? A dial that rose on reflexive taps is theater. This
 * module reads the same `approval_decision` events the gate already writes to
 * the ActivityLog (~/.claude/ide/activity-*.jsonl) and derives the signals that
 * separate judgement from rubber-stamping:
 *
 *   - reject rate   — a human who never says no isn't deciding (0% = a stamp).
 *   - latency       — how long you deliberated (decision ts − requestedAt). Sub-
 *                     second medians across the board are the tell of a stamp.
 *   - abandoned     — expired / cancelled prompts (approval fatigue / unreachable).
 *   - channel split — dashboard vs phone (where the oversight actually happens).
 *
 * Read-only and fail-soft: a missing/garbled log is an empty report, never a
 * throw. Latency needs the `requestedAt` field added to the decision event
 * (approvalHttp.ts) — older rows lack it and are counted but excluded from
 * latency, which is unrecoverable retroactively (the queue entry is long gone).
 */

import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Outcomes that reflect a HUMAN decision (a queue wait resolved), vs the
 * instant-policy emits (gate_off / cc_allow_rule / gate_below_threshold / …)
 * that never reached a person. Only these count toward the KPI. */
const APPROVED = "approved";
const REJECTED = "rejected";
const ABANDONED_REASONS = new Set(["expired", "cancelled"]);
const HUMAN_REASONS = new Set([APPROVED, REJECTED, "expired", "cancelled"]);

export interface ConsideredDecision {
  toolName: string;
  /** Classified outcome — distinguishes a real rejection from a timeout, which
   * the raw `decision: "deny"` field conflates (both are "deny"). */
  outcome: "approved" | "rejected" | "abandoned";
  /** Epoch-ms the decision was logged. */
  decidedAt: number;
  /** Epoch-ms the approval was prompted (queued); undefined on legacy rows. */
  requestedAt?: number;
  /** Where the human decided: "dashboard" | "phone" | "unknown". */
  channel: string;
  tier?: string;
  sessionId?: string;
}

export interface ReadDecisionsOpts {
  /** Override ~/.claude/ide (tests / remote). */
  ideDir?: string;
  /** Only decisions at/after this epoch-ms. */
  sinceMs?: number;
}

/**
 * Read human-deliberated approval decisions from the ActivityLog. Instant-policy
 * decisions (auto-allowed sub-threshold calls, CC allow/deny rules) are skipped
 * — they involved no human, so they aren't "considered approvals".
 */
export function readConsideredDecisions(
  opts: ReadDecisionsOpts = {},
): ConsideredDecision[] {
  const ideDir = opts.ideDir ?? path.join(os.homedir(), ".claude", "ide");
  let files: string[];
  try {
    files = readdirSync(ideDir).filter((f) => /^activity-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out: ConsideredDecision[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(path.join(ideDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      // cheap pre-filter before the JSON.parse
      if (!t.includes("approval_decision")) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (obj.event !== "approval_decision") continue;
      const md = (obj.metadata ?? {}) as Record<string, unknown>;
      if (typeof md.toolName !== "string") continue;
      const reason = typeof md.reason === "string" ? md.reason : "";
      const requestedAt =
        typeof md.requestedAt === "number" ? md.requestedAt : undefined;
      const channel = typeof md.channel === "string" ? md.channel : "";
      // Human-deliberated iff it carries a `channel` (the dashboard/phone
      // approve|reject path — where WORKER-gate approvals actually land), a
      // `requestedAt`, or a human-outcome `reason` (legacy CC-hook rows).
      // Everything else is instant policy (gate_off / cc_allow_rule / …),
      // excluded — those never reached a person.
      const isHuman =
        channel !== "" ||
        requestedAt !== undefined ||
        HUMAN_REASONS.has(reason);
      if (!isHuman) continue;
      const decidedAt =
        typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) || 0 : 0;
      if (opts.sinceMs !== undefined && decidedAt < opts.sinceMs) continue;
      // A channel'd event is a human click → outcome from `decision` (its
      // `reason`, if any, is free-form rejection text, not an outcome marker).
      // A channel-less CC-hook event uses `reason` to flag expired/cancelled.
      const outcome: ConsideredDecision["outcome"] =
        channel === "" && ABANDONED_REASONS.has(reason)
          ? "abandoned"
          : md.decision === "allow"
            ? "approved"
            : "rejected";
      out.push({
        toolName: md.toolName,
        outcome,
        decidedAt,
        ...(requestedAt !== undefined && { requestedAt }),
        channel: channel || "unknown",
        ...(typeof md.tier === "string" && { tier: md.tier }),
        ...(typeof md.sessionId === "string" && { sessionId: md.sessionId }),
      });
    }
  }
  out.sort((a, b) => a.decidedAt - b.decidedAt);
  return out;
}

export interface LatencyStats {
  count: number;
  medianMs: number;
  p90Ms: number;
}

export interface ToolKpi {
  toolName: string;
  /** approved + rejected (decided by a human). Abandoned excluded. */
  decided: number;
  approved: number;
  rejected: number;
  abandoned: number;
  /** rejected / decided — 0 means a possible rubber-stamp. */
  rejectRate: number;
  latency: LatencyStats | null;
  /** channel → count (dashboard / phone / unknown). */
  channels: Record<string, number>;
}

export interface ConsideredApprovalKpi {
  /** Total human-deliberated decisions in window (incl. abandoned). */
  total: number;
  decided: number;
  approved: number;
  rejected: number;
  abandoned: number;
  rejectRate: number;
  latency: LatencyStats | null;
  channels: Record<string, number>;
  byTool: ToolKpi[];
  /** Decisions per ISO day (chronological) — the approvals-per-week trend. */
  perDay: Array<{ day: string; decided: number; rejected: number }>;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx] as number;
}

function latencyOf(decisions: ConsideredDecision[]): LatencyStats | null {
  const lat = decisions
    .filter((d) => d.requestedAt !== undefined)
    .map((d) => d.decidedAt - (d.requestedAt as number))
    .filter((x) => x >= 0)
    .sort((a, b) => a - b);
  if (lat.length === 0) return null;
  return {
    count: lat.length,
    medianMs: percentile(lat, 50),
    p90Ms: percentile(lat, 90),
  };
}

function channelsOf(decisions: ConsideredDecision[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const d of decisions) c[d.channel] = (c[d.channel] ?? 0) + 1;
  return c;
}

/**
 * Aggregate decisions into the considered-approval KPI. Reject rate and latency
 * are computed over DECIDED (approved + rejected); abandoned (expired/cancelled)
 * is tracked separately so a timeout never masquerades as a rejection.
 */
export function computeConsideredApprovalKpi(
  decisions: ConsideredDecision[],
): ConsideredApprovalKpi {
  const decidedDs = decisions.filter((d) => d.outcome !== "abandoned");
  const approved = decidedDs.filter((d) => d.outcome === "approved").length;
  const rejected = decidedDs.filter((d) => d.outcome === "rejected").length;
  const abandoned = decisions.length - decidedDs.length;
  const decided = decidedDs.length;

  const byToolMap = new Map<string, ConsideredDecision[]>();
  for (const d of decisions) {
    const arr = byToolMap.get(d.toolName) ?? [];
    arr.push(d);
    byToolMap.set(d.toolName, arr);
  }
  const byTool: ToolKpi[] = [...byToolMap.entries()]
    .map(([toolName, ds]) => {
      const dec = ds.filter((d) => d.outcome !== "abandoned");
      const ap = dec.filter((d) => d.outcome === "approved").length;
      const rej = dec.filter((d) => d.outcome === "rejected").length;
      return {
        toolName,
        decided: dec.length,
        approved: ap,
        rejected: rej,
        abandoned: ds.length - dec.length,
        rejectRate: dec.length ? rej / dec.length : 0,
        latency: latencyOf(dec),
        channels: channelsOf(ds),
      };
    })
    .sort((a, b) => b.decided - a.decided);

  const perDayMap = new Map<string, { decided: number; rejected: number }>();
  for (const d of decidedDs) {
    const day = new Date(d.decidedAt).toISOString().slice(0, 10);
    const e = perDayMap.get(day) ?? { decided: 0, rejected: 0 };
    e.decided++;
    if (d.outcome === "rejected") e.rejected++;
    perDayMap.set(day, e);
  }
  const perDay = [...perDayMap.entries()]
    .map(([day, e]) => ({ day, ...e }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    total: decisions.length,
    decided,
    approved,
    rejected,
    abandoned,
    rejectRate: decided ? rejected / decided : 0,
    latency: latencyOf(decidedDs),
    channels: channelsOf(decisions),
    byTool,
    perDay,
  };
}
