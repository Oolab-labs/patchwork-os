import type { DecisionTraceLog } from "../decisionTraceLog.js";
import {
  error,
  optionalString,
  requireString,
  successStructured,
} from "./utils.js";

/**
 * Agent writer advertised in the MCP handshake as
 * `ctxSaveTrace(ref, problem, solution)`. Records a durable decision
 * trace after resolving a task so future sessions can find it via
 * `ctxQueryTraces(traceType: "decision")` or the injected digest.
 *
 * This is the writer half of the Phase 3 moat — `ctxGetTaskContext`
 * gives agents cross-session *read*, `ctxSaveTrace` gives them
 * cross-session *write*.
 */

export function createCtxSaveTraceTool(
  workspace: string,
  log: DecisionTraceLog,
  getSessionId?: () => string | undefined,
) {
  return {
    schema: {
      name: "ctxSaveTrace",
      description:
        "Record a problem+solution trace after resolving a task. Future sessions see it via ctxQueryTraces and the session-start digest. Keep problem + solution to one line each.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["ref", "problem", "solution"],
        properties: {
          ref: {
            type: "string",
            description:
              "What the trace is about: issue ref (#42), PR ref (PR-42), commit SHA, or short free text.",
            maxLength: 256,
          },
          problem: {
            type: "string",
            description:
              "One-line summary of the problem. What was broken or unclear?",
            maxLength: 500,
          },
          solution: {
            type: "string",
            description:
              "One-line summary of the fix. What was the root cause and what resolved it?",
            maxLength: 500,
          },
          tags: {
            type: "array",
            description:
              "Up to 10 short labels for search (`flaky-test`, `perf`, `security`, `migration`). Each ≤32 chars.",
            items: { type: "string", maxLength: 32 },
            maxItems: 10,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          seq: { type: "integer" },
          ref: { type: "string" },
          createdAt: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["seq", "ref", "createdAt"],
      },
    },
    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
      try {
        const ref = requireString(args, "ref", 256);
        const problem = requireString(args, "problem", 500);
        const solution = requireString(args, "solution", 500);

        const tagsInput = args.tags;
        let tags: string[] | undefined;
        if (Array.isArray(tagsInput)) {
          tags = tagsInput
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        }

        // Validate optional fields — throws on wrong type.
        void optionalString(args, "sessionId");

        const trace = log.record({
          ref,
          problem,
          solution,
          workspace,
          ...(tags && tags.length > 0 && { tags }),
          ...(getSessionId?.() && { sessionId: getSessionId() }),
        });
        return successStructured({
          seq: trace.seq,
          ref: trace.ref,
          createdAt: trace.createdAt,
          ...(trace.tags && { tags: trace.tags }),
        });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
