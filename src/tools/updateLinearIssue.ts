import { loadTokens, updateIssue } from "../connectors/linear.js";
import { requireString, successStructured } from "./utils.js";

export function createUpdateLinearIssueTool() {
  return {
    schema: {
      name: "updateLinearIssue",
      description:
        "Update an existing Linear issue. Pass only the fields you want to change. Requires Linear connector connected.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Issue identifier (e.g. 'ENG-42') or URL.",
            maxLength: 200,
          },
          title: { type: "string", maxLength: 500 },
          description: { type: "string", maxLength: 10000 },
          priority: {
            type: "integer",
            description: "0=no priority, 1=urgent, 2=high, 3=medium, 4=low.",
            minimum: 0,
            maximum: 4,
          },
          state: {
            type: "string",
            description: "Workflow state name (e.g. 'In Progress', 'Done').",
            maxLength: 100,
          },
          assignee: {
            type: "string",
            description: "Assignee name or email.",
            maxLength: 200,
          },
          labelNames: {
            type: "array",
            description: "Label names to set (replaces existing labels).",
            items: { type: "string", maxLength: 100 },
            maxItems: 10,
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
          url: { type: "string" },
          state: { type: "string" },
          linearConnected: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["id", "identifier", "title", "url", "linearConnected"],
      },
    },
    timeoutMs: 20_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tokens = loadTokens();
      if (!tokens) {
        return successStructured({
          id: "",
          identifier: "",
          title: "",
          url: "",
          linearConnected: false,
          error:
            "Linear not connected. GET /connections/linear/authorize first.",
        });
      }

      const id = requireString(args, "id", 200);
      const labelNames = Array.isArray(args.labelNames)
        ? (args.labelNames as unknown[])
            .filter((l) => typeof l === "string")
            .map(String)
        : undefined;

      try {
        const issue = await updateIssue(
          {
            id,
            ...(typeof args.title === "string" && { title: args.title }),
            ...(typeof args.description === "string" && {
              description: args.description,
            }),
            ...(typeof args.priority === "number" && {
              priority: args.priority,
            }),
            ...(typeof args.state === "string" && { state: args.state }),
            ...(typeof args.assignee === "string" && {
              assignee: args.assignee,
            }),
            ...(labelNames && labelNames.length > 0 && { labels: labelNames }),
          },
          signal,
        );
        return successStructured({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          state: issue.state?.name ?? "",
          linearConnected: true,
        });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          id: "",
          identifier: "",
          title: "",
          url: "",
          linearConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
