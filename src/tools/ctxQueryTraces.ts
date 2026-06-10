import type { ActivityLog } from "../activityLog.js";
import type { CommitIssueLinkLog } from "../commitIssueLinkLog.js";
import type { DecisionTraceLog } from "../decisionTraceLog.js";
import { cosineSimilarity } from "../embeddings/index.js";
import type { RecipeRunLog } from "../runLog.js";
import { optionalInt, optionalString, successStructured } from "./utils.js";

/**
 * Minimum cosine score for a trace to survive semantic ranking. Below this
 * floor a trace is dropped (treated as "not relevant"). Conservative — the
 * intent is to filter obvious noise, not to gate borderline matches.
 */
const SEMANTIC_FLOOR = 0.25;

/**
 * Bounds for the single embeddings request issued by {@link semanticRank}.
 * Without these, a full 500-trace pool — each recipe_run carrying a 2000-char
 * outputTail — produces one giant batch that can exceed the embedding model's
 * token limit (silent null fail-soft) or OOM on JSON serialization
 * (core-infra-3). Cap each text and cap how many texts go in the batch.
 */
const MAX_SEMANTIC_TEXT_CHARS = 512;
const MAX_SEMANTIC_BATCH = 200;

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
  /**
   * Optional on-device embeddings function — wired from
   * `createEmbeddingsProvider()?.embed` at the registration site. Returns one
   * vector per input text, or `null` when embeddings are unavailable
   * (unconfigured endpoint / error). Absent ⇒ semantic ranking is disabled and
   * behavior is byte-identical to the substring path.
   */
  embedFn?: (texts: string[]) => Promise<number[][] | null>;
}

/**
 * The default case-insensitive substring match: summary first, then the
 * serialized body. Shared by the default path and the semantic fallback so
 * the two produce byte-identical results when embeddings are unavailable.
 */
function matchesSubstring(t: DecisionTrace, qNeedle: string): boolean {
  if (t.summary.toLowerCase().includes(qNeedle)) return true;
  try {
    return JSON.stringify(t.body).toLowerCase().includes(qNeedle);
  } catch {
    return false;
  }
}

/**
 * Build the per-type text we vectorize for semantic ranking. Reads from the
 * raw `body` row with safe typeof guards (never throws); falls back to the
 * human summary when type-specific fields are absent.
 */
function semanticTextFor(t: DecisionTrace): string {
  const b = t.body;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const cap = (s: string): string => s.slice(0, MAX_SEMANTIC_TEXT_CHARS);
  switch (t.traceType) {
    case "decision": {
      const tags = Array.isArray(b.tags)
        ? b.tags.filter((x): x is string => typeof x === "string").join(" ")
        : "";
      return cap(
        `${str(b.ref)} ${str(b.problem)} ${str(b.solution)} ${tags}`.trim(),
      );
    }
    case "enrichment":
      return cap(`${str(b.subject)} ${str(b.issueTitle)} ${str(b.ref)}`.trim());
    case "recipe_run":
      return cap(
        `${str(b.recipeName)} ${str(b.errorMessage)} ${str(
          b.outputTail,
        )}`.trim(),
      );
    case "approval":
      return cap(
        `${str(b.toolName)} ${str(b.decision)} ${str(b.reason)} ${str(
          b.summary,
        )}`.trim(),
      );
    default:
      return cap(t.summary);
  }
}

/**
 * Rank `filtered` by cosine similarity to `query`. Returns the top-`limit`
 * traces sorted score-descending (above {@link SEMANTIC_FLOOR}), or `null`
 * to signal fail-soft fallback to the recency path (embeddings unavailable /
 * error / empty pool). Never throws.
 */
async function semanticRank(
  filtered: DecisionTrace[],
  query: string,
  embedFn: (texts: string[]) => Promise<number[][] | null>,
  limit: number,
): Promise<DecisionTrace[] | null> {
  if (filtered.length === 0) return [];
  try {
    // Bound the embeddings batch so a large pool can't exceed the model's token
    // limit or OOM serialization. `filtered` arrives recency-ordered, so the
    // most recent MAX_SEMANTIC_BATCH candidates are the ones we rank.
    const pool =
      filtered.length > MAX_SEMANTIC_BATCH
        ? filtered.slice(0, MAX_SEMANTIC_BATCH)
        : filtered;
    const texts = [query, ...pool.map(semanticTextFor)];
    const vectors = await embedFn(texts);
    // Need the query vec + one per trace; anything else ⇒ fall back.
    if (!vectors || vectors.length !== texts.length) return null;
    const queryVec = vectors[0];
    if (!queryVec) return null;
    const scored: { trace: DecisionTrace; score: number }[] = [];
    for (let i = 0; i < pool.length; i++) {
      const trace = pool[i];
      const vec = vectors[i + 1];
      if (!trace || !vec) continue;
      const score = cosineSimilarity(queryVec, vec);
      if (score < SEMANTIC_FLOOR) continue;
      scored.push({ trace, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.trace);
  } catch {
    return null;
  }
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
          semantic: {
            type: "boolean",
            description:
              "When true AND an embeddings endpoint is configured AND q is set, rank results by on-device semantic similarity instead of recency. Falls back to substring match when embeddings are unavailable.",
          },
          tag: {
            type: "string",
            description:
              "Restrict to decision traces carrying this tag (exact match, case-sensitive). Other trace types don't have tags and will be excluded when this filter is set.",
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
      const semantic = args.semantic === true;
      const tagFilter = optionalString(args, "tag");
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

      // In semantic mode `q` is the similarity query, NOT a substring
      // prefilter — using it to drop rows would gate out the very traces we
      // want to rank. since/tag/key still apply as hard filters.
      const semanticActive =
        semantic && Boolean(qFilter) && Boolean(deps.embedFn);
      const qNeedleActive = qFilter && !semanticActive;
      const needsFilter =
        since !== undefined || tagFilter || keyFilter || qNeedleActive;
      let filtered: DecisionTrace[];
      if (!needsFilter) {
        filtered = pools;
      } else {
        const qNeedle = qNeedleActive ? qFilter?.toLowerCase() : undefined;
        filtered = [];
        for (const t of pools) {
          if (since !== undefined && t.ts <= since) continue;
          if (tagFilter) {
            if (t.traceType !== "decision") continue;
            const tags = t.body.tags;
            if (!Array.isArray(tags) || !tags.includes(tagFilter)) continue;
          }
          if (keyFilter && !t.key.includes(keyFilter)) continue;
          if (qNeedle && !matchesSubstring(t, qNeedle)) continue;
          filtered.push(t);
        }
      }

      // Opt-in semantic ranking: only when explicitly requested, a query is
      // present, and an embeddings function is wired. Any miss (null vectors,
      // error, unconfigured) returns null → fall through to the substring +
      // recency path so behavior is byte-identical to a non-semantic call.
      if (semanticActive && qFilter && deps.embedFn) {
        const ranked = await semanticRank(
          filtered,
          qFilter,
          deps.embedFn,
          limit,
        );
        // A non-empty ranked array is a real semantic result. An EMPTY array
        // means every candidate scored below the floor (or there were none) —
        // treat that like a miss and fall through to substring search rather
        // than returning zero results with no explanation (audit sem-2). null
        // already signals embeddings unavailable.
        if (ranked && ranked.length > 0) {
          return successStructured({
            traces: ranked,
            count: ranked.length,
            sources,
          });
        }
        // Fallback: embeddings unavailable or all-below-floor. Apply the
        // substring filter we skipped in semantic mode, then recency-sort.
        const qNeedle = qFilter.toLowerCase();
        filtered = filtered.filter((t) => matchesSubstring(t, qNeedle));
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
