import { fetchGitHubIssue } from "../connectors/github.js";
import { requireString, successStructured } from "./utils.js";

export function createFetchGithubIssueTool() {
  return {
    schema: {
      name: "fetchGithubIssue",
      description:
        "Fetch a GitHub issue by URL or owner/repo#number ref. Returns title, body, state, labels, assignees, and author. Requires GitHub connector connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["issueRef"],
        properties: {
          issueRef: {
            type: "string",
            description:
              "GitHub issue URL (https://github.com/owner/repo/issues/42) or short ref (owner/repo#42).",
            maxLength: 500,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          number: { type: "integer" },
          title: { type: "string" },
          body: { type: "string" },
          state: { type: "string" },
          url: { type: "string" },
          repo: { type: "string" },
          author: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          assignees: { type: "array", items: { type: "string" } },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
          comments: { type: "integer" },
          githubConnected: { type: "boolean" },
        },
        required: [
          "number",
          "title",
          "body",
          "state",
          "url",
          "repo",
          "author",
          "labels",
          "assignees",
          "createdAt",
          "updatedAt",
          "comments",
          "githubConnected",
        ],
      },
    },
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const issueRef = requireString(args, "issueRef", 500);
      try {
        const issue = await fetchGitHubIssue(issueRef, signal);
        return successStructured({ ...issue, githubConnected: true });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          number: 0,
          title: "",
          body: "",
          state: "",
          url: "",
          repo: "",
          author: "",
          labels: [],
          assignees: [],
          createdAt: "",
          updatedAt: "",
          comments: 0,
          githubConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
