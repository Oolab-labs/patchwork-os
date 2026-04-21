import { addComment, loadTokens } from "../connectors/linear.js";
import { requireString, successStructured } from "./utils.js";

export function createAddLinearCommentTool() {
  return {
    schema: {
      name: "addLinearComment",
      description:
        "Add a comment to a Linear issue. Requires Linear connector connected.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["id", "body"],
        properties: {
          id: {
            type: "string",
            description: "Issue identifier (e.g. 'ENG-42') or URL.",
            maxLength: 200,
          },
          body: {
            type: "string",
            description: "Comment body (Markdown).",
            maxLength: 10000,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
          body: { type: "string" },
          url: { type: "string" },
          linearConnected: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["id", "body", "linearConnected"],
      },
    },
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tokens = loadTokens();
      if (!tokens) {
        return successStructured({
          id: "",
          body: "",
          linearConnected: false,
          error:
            "Linear not connected. GET /connections/linear/authorize first.",
        });
      }

      const id = requireString(args, "id", 200);
      const body = requireString(args, "body", 10000);

      try {
        const comment = await addComment(id, body, signal);
        return successStructured({
          id: comment.id,
          body: comment.body,
          url: comment.url ?? "",
          linearConnected: true,
        });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          id: "",
          body: "",
          linearConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
