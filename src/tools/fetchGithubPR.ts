import { fetchGitHubPR } from "../connectors/github.js";
import { requireString, successStructured } from "./utils.js";

export function createFetchGithubPRTool() {
  return {
    schema: {
      name: "fetchGithubPR",
      description:
        "Fetch a GitHub pull request by URL or owner/repo#number ref. Returns title, body, state, branches, labels, review decision, and diff stats. Requires GitHub connector connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["prRef"],
        properties: {
          prRef: {
            type: "string",
            description:
              "GitHub PR URL (https://github.com/owner/repo/pull/42) or short ref (owner/repo#42).",
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
          isDraft: { type: "boolean" },
          reviewDecision: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          headBranch: { type: "string" },
          baseBranch: { type: "string" },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
          additions: { type: "integer" },
          deletions: { type: "integer" },
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
          "isDraft",
          "reviewDecision",
          "labels",
          "headBranch",
          "baseBranch",
          "createdAt",
          "updatedAt",
          "additions",
          "deletions",
          "githubConnected",
        ],
      },
    },
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const prRef = requireString(args, "prRef", 500);
      try {
        const pr = await fetchGitHubPR(prRef, signal);
        return successStructured({ ...pr, githubConnected: true });
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
          isDraft: false,
          reviewDecision: "",
          labels: [],
          headBranch: "",
          baseBranch: "",
          createdAt: "",
          updatedAt: "",
          additions: 0,
          deletions: 0,
          githubConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
