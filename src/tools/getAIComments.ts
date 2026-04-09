import {
  type AIComment,
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, successStructured } from "./utils.js";

export function createGetAICommentsTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getAIComments",
      description:
        "Scan open documents for AI-tagged comments (// AI: <severity>: <message>). " +
        "Severity: fix, todo, question, warn, task. Call before createGithubIssueFromAIComment.",
      extensionRequired: true,
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          count: { type: "integer" as const },
          comments: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                file: { type: "string" as const },
                line: { type: "integer" as const },
                comment: { type: "string" as const },
                syntax: { type: "string" as const },
                fullLine: { type: "string" as const },
                severity: {
                  type: "string" as const,
                  enum: ["fix", "todo", "question", "warn", "task"],
                },
              },
              required: ["file", "line", "comment", "syntax", "fullLine"],
            },
          },
          summary: {
            type: "object" as const,
            additionalProperties: { type: "integer" as const },
          },
          message: { type: "string" as const },
          tip: { type: "string" as const },
        },
        required: ["count", "comments"],
      },
    },
    timeoutMs: 10_000,
    async handler() {
      if (!extensionClient.isConnected()) {
        return error(
          "Extension not connected. Open a VS Code/Windsurf/Cursor window with the claude-ide-bridge extension active.",
        );
      }
      let comments: AIComment[] | null = null;
      try {
        comments = await extensionClient.getAIComments();
      } catch (err) {
        if (!(err instanceof ExtensionTimeoutError)) throw err;
        return error(
          "Extension timed out while scanning for AI comments. Try again.",
        );
      }
      if (comments === null) {
        return error("Extension disconnected while scanning for AI comments.");
      }

      // Update the shared cache so createGithubIssueFromAIComment can find them
      extensionClient.latestAIComments.clear();
      for (const comment of comments) {
        const existing =
          extensionClient.latestAIComments.get(comment.file) ?? [];
        existing.push(comment);
        extensionClient.latestAIComments.set(comment.file, existing);
      }

      if (comments.length === 0) {
        return successStructured({
          count: 0,
          comments: [],
          message:
            "No AI comments found in open documents. Add `// AI: fix: <message>` style comments to flag work items.",
        });
      }

      // Group by severity for a useful summary
      const bySeverity: Record<string, number> = {};
      for (const c of comments) {
        const sev = c.severity ?? "task";
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      }

      return successStructured({
        count: comments.length,
        comments,
        summary: bySeverity,
        tip: "Use createGithubIssueFromAIComment to file a GitHub issue for a specific comment.",
      });
    },
  };
}
