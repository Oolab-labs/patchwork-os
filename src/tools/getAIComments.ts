import {
  type AIComment,
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, success } from "./utils.js";

export function createGetAICommentsTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "getAIComments",
      description:
        "Scan all open documents for AI-tagged comments and return them. " +
        "AI comments use the format `// AI: <severity>: <message>` where severity is " +
        "fix, todo, question, warn, or task. " +
        "Populates the cache used by createGithubIssueFromAIComment — call this first " +
        "before filing issues from AI comments.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
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
        return success({
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

      return success({
        count: comments.length,
        comments,
        summary: bySeverity,
        tip: "Use createGithubIssueFromAIComment to file a GitHub issue for a specific comment.",
      });
    },
  };
}
