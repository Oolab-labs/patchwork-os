import type { ActivityLog } from "../activityLog.js";
import type { CommitIssueLinkLog } from "../commitIssueLinkLog.js";
import type { DecisionTraceLog } from "../decisionTraceLog.js";
import type { RecipeRunLog } from "../runLog.js";
import { optionalInt, optionalString, successStructured } from "./utils.js";

/**
 * Unified view over the persistent decision trails that already exist:
 *   - approval decisions    (activityLog lifecycle rows, event = "approval_decision")
 *   - enrichment links      (CommitIssueLinkLog)
 *   - recipe runs           (RecipeRunLog)
 *
 * The three logs each have their own dedup / retention semantics, so we
 * keep them as separate writers. This tool is the read layer — a single
 * place to answer "why did X happen last Tuesday?" across trace types.
 *
 * Schema is intentionally narrow: `traceType` + universal fields
 * (`ts`, `key`, `summary`) + the raw source row as `body`. Consumers that
 * need richer per-type shapes can key on `traceType` and unwrap `body`.
 */

export type TraceType = "approval" | "enrichment" | "recipe_run" | "decision";

export interface DecisionTrace {
  traceType: TraceType;
  /** ms epoch when the trace was recorded. */
  ts: number;
  /**
   * Natural key for dedup / join:
   *   approval  → `<sessionId>:<toolName>` (or `anon:<toolName>` if no session)
   *   enrichment → `<sha>:<ref>`
   *   recipe_run → `<taskId>`
   */
  key: string;
  /** Short human-readable summary for the dashboard / CLI. */
  summary: string;
  /** The original row as-persisted. */
  body: Record<string, unknown>;
}

export interface CtxQueryTracesDeps {
  recipeRunLog?: RecipeRunLog | null;
  commitIssueLinkLog?: CommitIssueLinkLog | null;
  activityLog?: ActivityLog | null;
  decisionTraceLog?: DecisionTraceLog | null;
}

function approvalTraces(activityLog: ActivityLog): DecisionTrace[] {
  const out: DecisionTrace[] = [];
  // queryTimeline returns combined tool+lifecycle; filter to approval rows.
  // Use a generous `last` — the tool's own `limit` arg is applied after
  // cross-source merge.
  const timeline = activityLog.queryTimeline({ last: 500 });
  for (const entry of timeline) {
    if (entry.kind !== "lifecycle") continue;
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    if (entry.event !== "approval_decision") continue;
    const tool = typeof meta.toolName === "string" ? meta.toolName : "";
    const decision = typeof meta.decision === "string" ? meta.decision : "";
    const reason = typeof meta.reason === "string" ? meta.reason : "";
    const sessionId =
      typeof meta.sessionId === "string" ? meta.sessionId : "anon";
    out.push({
      traceType: "approval",
      ts: Date.parse(entry.timestamp),
      key: `${sessionId}:${tool || "unknown"}`,
      summary: `${decision || "?"} ${tool || "?"}${reason ? ` (${reason})` : ""}`,
      body: { ...meta, timestamp: entry.timestamp, id: entry.id },
    });
  }
  return out;
}

function enrichmentTraces(log: CommitIssueLinkLog): DecisionTrace[] {
  return log.query({ limit: 500 }).map((l) => ({
    traceType: "enrichment",
    ts: l.createdAt,
    key: `${l.sha}:${l.ref}`,
    summary: `${l.linkType} ${l.ref} ${
      l.resolved ? "(resolved)" : `(unresolved: ${l.reason ?? "?"})`
    }${l.subject ? ` — ${l.subject}` : ""}`,
    body: l as unknown as Record<string, unknown>,
  }));
}

function recipeRunTraces(log: RecipeRunLog): DecisionTrace[] {
  return log.query({ limit: 500 }).map((r) => ({
    traceType: "recipe_run",
    ts: r.doneAt,
    key: r.taskId,
    summary: `${r.recipeName} (${r.trigger}) → ${r.status}${
      r.errorMessage ? `: ${r.errorMessage}` : ""
    }`,
    body: r as unknown as Record<string, unknown>,
  }));
}

function decisionTraces(log: DecisionTraceLog): DecisionTrace[] {
  return log.query({ limit: 500 }).map((d) => ({
    traceType: "decision",
    ts: d.createdAt,
    key: d.ref,
    summary: `${d.ref} — ${d.solution}`,
    body: d as unknown as Record<string, unknown>,
  }));
}

export function createCtxQueryTracesTool(deps: CtxQueryTracesDeps) {
  return {
    schema: {
      name: "ctxQueryTraces",
      description:
        "Unified query over approval / enrichment / recipe-run trails. Filter by traceType, time window, or natural key. Answers 'why did X happen' across sources.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          traceType: {
            type: "string",
            enum: ["approval", "enrichment", "recipe_run", "decision"],
            description:
              "Optional filter — restrict to one source. Omit to get all.",
          },
          key: {
            type: "string",
            description:
              "Exact key match (sessionId:toolName / sha:ref / taskId). Substring match on the key; case-sensitive.",
          },
          q: {
            type: "string",
            description:
              "Case-insensitive substring search across the trace summary and serialized body. Use for free-form lookup when the key schema doesn't fit.",
          },
          since: {
            type: "integer",
            description: "Only return traces with ts > this ms-epoch value.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Max results after filtering. Default 100.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          traces: {
            type: "array",
            items: {
              type: "object",
              properties: {
                traceType: {
                  type: "string",
                  enum: ["approval", "enrichment", "recipe_run", "decision"],
                },
                ts: { type: "integer" },
                key: { type: "string" },
                summary: { type: "string" },
                body: { type: "object" },
              },
              required: ["traceType", "ts", "key", "summary", "body"],
            },
          },
          count: { type: "integer" },
          sources: {
            type: "object",
            properties: {
              approval: { type: "boolean" },
              enrichment: { type: "boolean" },
              recipe_run: { type: "boolean" },
              decision: { type: "boolean" },
            },
          },
        },
        required: ["traces", "count", "sources"],
      },
    },
    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
      const traceType = optionalString(args, "traceType") as
        | TraceType
        | undefined
        | "";
      const keyFilter = optionalString(args, "key");
      const qFilter = optionalString(args, "q");
      const since = optionalInt(args, "since", 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInt(args, "limit", 1, 500) ?? 100;

      const sources = {
        approval: Boolean(deps.activityLog),
        enrichment: Boolean(deps.commitIssueLinkLog),
        recipe_run: Boolean(deps.recipeRunLog),
        decision: Boolean(deps.decisionTraceLog),
      };

      const pools: DecisionTrace[] = [];
      if ((!traceType || traceType === "approval") && deps.activityLog) {
        pools.push(...approvalTraces(deps.activityLog));
      }
      if (
        (!traceType || traceType === "enrichment") &&
        deps.commitIssueLinkLog
      ) {
        pools.push(...enrichmentTraces(deps.commitIssueLinkLog));
      }
      if ((!traceType || traceType === "recipe_run") && deps.recipeRunLog) {
        pools.push(...recipeRunTraces(deps.recipeRunLog));
      }
      if ((!traceType || traceType === "decision") && deps.decisionTraceLog) {
        pools.push(...decisionTraces(deps.decisionTraceLog));
      }

      let filtered = pools;
      if (since !== undefined) filtered = filtered.filter((t) => t.ts > since);
      if (keyFilter) {
        const needle = keyFilter;
        filtered = filtered.filter((t) => t.key.includes(needle));
      }
      if (qFilter) {
        const needle = qFilter.toLowerCase();
        filtered = filtered.filter((t) => {
          if (t.summary.toLowerCase().includes(needle)) return true;
          try {
            return JSON.stringify(t.body).toLowerCase().includes(needle);
          } catch {
            return false;
          }
        });
      }

      filtered.sort((a, b) => b.ts - a.ts);
      const traces = filtered.slice(0, limit);

      return successStructured({
        traces,
        count: traces.length,
        sources,
      });
    },
  };
}
