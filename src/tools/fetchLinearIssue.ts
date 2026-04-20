import { fetchIssue } from "../connectors/linear.js";
import { requireString, successStructured } from "./utils.js";

/**
 * fetchLinearIssue — fetch a Linear issue by ID or URL.
 *
 * Returns title, description, state, assignee, labels, priority, and URL
 * in a single call. Requires Linear connector to be connected.
 */
export function createFetchLinearIssueTool() {
  return {
    schema: {
      name: "fetchLinearIssue",
      description:
        "Fetch a Linear issue by identifier or URL. Returns title, description, state, assignee, labels, and priority. Requires Linear connector connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["issueId"],
        properties: {
          issueId: {
            type: "string",
            description:
              "Linear issue identifier (e.g. 'LIN-42', 'TEAM-123') or full issue URL.",
            maxLength: 500,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
          identifier: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          state: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
            },
            required: ["name", "type"],
          },
          assignee: {
            type: ["object", "null"],
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
          },
          priority: { type: "integer" },
          priorityLabel: { type: "string" },
          url: { type: "string" },
          team: {
            type: "object",
            properties: {
              name: { type: "string" },
              key: { type: "string" },
            },
            required: ["name", "key"],
          },
          labels: {
            type: "array",
            items: { type: "string" },
          },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
          linearConnected: { type: "boolean" },
        },
        required: [
          "id",
          "identifier",
          "title",
          "state",
          "priority",
          "priorityLabel",
          "url",
          "team",
          "labels",
          "createdAt",
          "updatedAt",
          "linearConnected",
        ],
      },
    },
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const issueId = requireString(args, "issueId", 500);

      try {
        const issue = await fetchIssue(issueId, signal);
        return successStructured({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description ?? null,
          state: issue.state,
          assignee: issue.assignee ?? null,
          priority: issue.priority,
          priorityLabel: issue.priorityLabel,
          url: issue.url,
          team: issue.team,
          labels: issue.labels.nodes.map((l) => l.name),
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          linearConnected: true,
        });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          id: "",
          identifier: issueId,
          title: "",
          description: null,
          state: { name: "", type: "" },
          assignee: null,
          priority: 0,
          priorityLabel: "",
          url: "",
          team: { name: "", key: "" },
          labels: [],
          createdAt: "",
          updatedAt: "",
          linearConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
