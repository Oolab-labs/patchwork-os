import type { ActivityLog } from "../activityLog.js";
import type { CommitIssueLinkLog } from "../commitIssueLinkLog.js";
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
}

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
const DEFAULT_TOP_N = 5;
const MAX_BYTES = 2_048;
const MAX_SUMMARY_CHARS = 80;

const TYPE_ICON: Record<string, string> = {
  approval: "•",
  enrichment: "⇄",
  recipe_run: "▸",
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
  if (!deps.activityLog && !deps.commitIssueLinkLog && !deps.recipeRunLog) {
    return [];
  }

  const tool = createCtxQueryTracesTool(deps);
  const result = await tool.handler({
    since: Math.max(0, now - windowMs),
    limit: Math.max(topN * 2, 20),
  });

  const structured = (result as { structuredContent?: unknown })
    .structuredContent as
    | { traces?: Array<{ traceType: string; ts: number; summary: string }> }
    | undefined;
  const traces = structured?.traces ?? [];
  if (traces.length === 0) return [];

  const top = traces.slice(0, topN);
  const lines: string[] = ["RECENT DECISIONS (last 12h):"];
  for (const t of top) {
    const icon = TYPE_ICON[t.traceType] ?? "·";
    const summary = truncate(t.summary, MAX_SUMMARY_CHARS);
    const line = `  ${icon} ${summary} — ${relTime(t.ts, now)}`;
    lines.push(line);
  }

  // Hard byte cap — keep dropping oldest entries until under budget.
  while (lines.join("\n").length > MAX_BYTES && lines.length > 1) {
    lines.pop();
  }
  // If only the heading survived, drop it too (nothing useful to say).
  if (lines.length <= 1) return [];
  return lines;
}
