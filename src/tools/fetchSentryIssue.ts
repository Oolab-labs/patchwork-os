import { fetchIssueStackTrace } from "../connectors/sentry.js";
import { createEnrichStackTraceTool } from "./enrichStackTrace.js";
import { optionalInt, requireString, successStructured } from "./utils.js";

/**
 * fetchSentryIssue — fetch a Sentry issue/event and enrich its stack trace
 * with git blame data in one call.
 *
 * Combines:
 *   1. Sentry API fetch → raw stack trace text
 *   2. enrichStackTrace → per-frame commit attribution + top suspect
 *
 * Requires Sentry connector to be connected (POST /connections/sentry/connect).
 */
export function createFetchSentryIssueTool(workspace: string) {
  const enrichTool = createEnrichStackTraceTool(workspace);

  return {
    schema: {
      name: "fetchSentryIssue",
      description:
        "Fetch a Sentry issue and enrich its stack trace with git blame. Returns per-frame commit attribution + top suspect commit. Requires Sentry connector connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["issueId"],
        properties: {
          issueId: {
            type: "string",
            description:
              "Sentry issue ID (e.g. '12345') or full issue URL (e.g. 'https://sentry.io/organizations/my-org/issues/12345/').",
            maxLength: 500,
          },
          maxFrames: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Max stack frames to blame. Default 10.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          issueId: { type: "string" },
          title: { type: "string" },
          stackTrace: { type: "string" },
          frames: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                column: { type: ["integer", "null"] },
                function: { type: ["string", "null"] },
                language: { type: "string" },
                inWorkspace: { type: "boolean" },
                resolvedPath: { type: ["string", "null"] },
                commit: {
                  type: ["object", "null"],
                  properties: {
                    sha: { type: "string" },
                    author: { type: "string" },
                    date: { type: "string" },
                    subject: { type: "string" },
                  },
                },
              },
              required: ["file", "line", "language", "inWorkspace"],
            },
          },
          topSuspect: {
            type: ["object", "null"],
            properties: {
              sha: { type: "string" },
              author: { type: "string" },
              date: { type: "string" },
              subject: { type: "string" },
              frameCount: { type: "integer" },
            },
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          framesParsed: { type: "integer" },
          framesBlamed: { type: "integer" },
          gitAvailable: { type: "boolean" },
          sentryConnected: { type: "boolean" },
        },
        required: [
          "issueId",
          "title",
          "stackTrace",
          "frames",
          "confidence",
          "framesParsed",
          "framesBlamed",
          "gitAvailable",
          "sentryConnected",
        ],
      },
    },
    timeoutMs: 45_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const issueId = requireString(args, "issueId", 500);
      const maxFrames = optionalInt(args, "maxFrames", 1, 50) ?? 10;

      let stackTrace: string;
      let title: string;
      let resolvedIssueId: string;
      let sentryConnected = true;

      try {
        ({
          stackTrace,
          title,
          issueId: resolvedIssueId,
        } = await fetchIssueStackTrace(issueId, signal));
      } catch (err) {
        sentryConnected = false;
        return successStructured({
          issueId,
          title: "",
          stackTrace: "",
          frames: [],
          topSuspect: null,
          confidence: "low" as const,
          framesParsed: 0,
          framesBlamed: 0,
          gitAvailable: false,
          sentryConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Re-use enrichStackTrace handler with the fetched stack trace
      const enrichResult = await enrichTool.handler(
        { stackTrace, maxFrames },
        signal,
      );

      // enrichResult is a McpToolResult — extract the structured content
      const structured =
        enrichResult.structuredContent ??
        (enrichResult.content?.[0]?.type === "text"
          ? JSON.parse(enrichResult.content[0].text)
          : {});

      return successStructured({
        issueId: resolvedIssueId,
        title,
        stackTrace,
        sentryConnected,
        ...(structured as object),
      });
    },
  };
}
