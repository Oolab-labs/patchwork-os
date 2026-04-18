import type { ActivityLog } from "../activityLog.js";
import type { CommitIssueLinkLog } from "../commitIssueLinkLog.js";
import type { DecisionTraceLog } from "../decisionTraceLog.js";
import type { RecipeRunLog } from "../runLog.js";
import { createCtxQueryTracesTool } from "./ctxQueryTraces.js";

/**
 * Cold-start trace digest injected into session instructions.
 *
 * Agents reading the instructions see recent cross-session decisions
 * (approvals / enrichment links / recipe runs) without having to query
 * ctxQueryTraces first. Strictly read-only, strictly bounded.
 *
 * Budget: ≤2 KB total. Top 5 traces, summary + relative time only.
 * No bodies, no full keys — just enough signal to answer
 * "has something like this happened recently?"
 */

export interface RecentTracesDigestDeps {
  activityLog?: ActivityLog | null;
  commitIssueLinkLog?: CommitIssueLinkLog | null;
  recipeRunLog?: RecipeRunLog | null;
  decisionTraceLog?: DecisionTraceLog | null;
}

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
const DEFAULT_TOP_N = 5;
const MAX_BYTES = 2_048;
const MAX_SUMMARY_CHARS = 80;

const TYPE_ICON: Record<string, string> = {
  approval: "•",
  enrichment: "⇄",
  recipe_run: "▸",
  decision: "★",
};

function relTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Render a single digest line. Decision traces carry ref + tags + solution
 * that matter for agent self-triage, so we surface them explicitly instead
 * of collapsing into the generic summary. Other trace types use the summary
 * as-is — they don't share the ref/tag shape.
 */
function formatTraceLine(
  t: {
    traceType: string;
    ts: number;
    key: string;
    summary: string;
    body: Record<string, unknown>;
  },
  now: number,
): string {
  const when = relTime(t.ts, now);
  if (t.traceType === "decision") {
    const ref = String(t.body.ref ?? t.key);
    const solution =
      typeof t.body.solution === "string" ? t.body.solution : t.summary;
    const tags = Array.isArray(t.body.tags)
      ? (t.body.tags as unknown[])
          .filter((x): x is string => typeof x === "string")
          .slice(0, 3)
      : [];
    const tagPart = tags.length > 0 ? ` [${tags.join(",")}]` : "";
    // Budget: ref + tags + " — <when>" are fixed; truncate solution to fit.
    const prefix = `${ref}${tagPart} `;
    const suffix = ` — ${when}`;
    const budget = MAX_SUMMARY_CHARS - prefix.length - suffix.length;
    const body = budget > 10 ? truncate(solution, budget) : "";
    return `${prefix}${body}${suffix}`;
  }
  return `${truncate(t.summary, MAX_SUMMARY_CHARS)} — ${when}`;
}

interface FormatOptions {
  windowMs?: number;
  topN?: number;
  now?: number;
}

/**
 * Build the digest as an array of lines (including the heading and
 * indentation). Returns empty array if there's nothing to show.
 *
 * The caller decides how to join/embed these — buildInstructions() pushes
 * them into its `lines` array alongside the other sections.
 */
export async function buildRecentTracesDigest(
  deps: RecentTracesDigestDeps,
  options: FormatOptions = {},
): Promise<string[]> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const topN = options.topN ?? DEFAULT_TOP_N;
  const now = options.now ?? Date.now();

  // If no sources are available, skip the section entirely.
  if (
    !deps.activityLog &&
    !deps.commitIssueLinkLog &&
    !deps.recipeRunLog &&
    !deps.decisionTraceLog
  ) {
    return [];
  }

  const tool = createCtxQueryTracesTool(deps);
  const result = await tool.handler({
    since: Math.max(0, now - windowMs),
    limit: Math.max(topN * 2, 20),
  });

  const structured = (result as { structuredContent?: unknown })
    .structuredContent as
    | {
        traces?: Array<{
          traceType: string;
          ts: number;
          key: string;
          summary: string;
          body: Record<string, unknown>;
        }>;
      }
    | undefined;
  const traces = structured?.traces ?? [];
  if (traces.length === 0) return [];

  const top = traces.slice(0, topN);
  const lines: string[] = ["RECENT DECISIONS (last 12h):"];
  for (const t of top) {
    const icon = TYPE_ICON[t.traceType] ?? "·";
    lines.push(`  ${icon} ${formatTraceLine(t, now)}`);
  }

  // Hard byte cap — keep dropping oldest entries until under budget.
  while (lines.join("\n").length > MAX_BYTES && lines.length > 1) {
    lines.pop();
  }
  // If only the heading survived, drop it too (nothing useful to say).
  if (lines.length <= 1) return [];
  return lines;
}
