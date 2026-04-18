import type { CommitIssueLinkLog, LinkType } from "../commitIssueLinkLog.js";
import {
  error,
  optionalInt,
  optionalString,
  successStructured,
} from "./utils.js";

/**
 * Reverse lookup over the persisted commit→issue link log.
 * Answers: "which commits touch issue #N?" without re-running enrichment.
 */
export function createGetCommitsForIssueTool(
  workspace: string,
  linkLog: CommitIssueLinkLog,
) {
  return {
    schema: {
      name: "getCommitsForIssue",
      description:
        "Reverse commit→issue lookup from the persisted enrichment log. Returns commits that referenced the given issue, newest first.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["issue"],
        properties: {
          issue: {
            type: "string",
            description:
              "Issue ref: `#42`, `42`, or `GH-42`. Normalized to `#N` internally.",
          },
          linkType: {
            type: "string",
            enum: ["closes", "references"],
            description:
              "Optional filter — only `closes` or only `references`.",
          },
          workspaceScope: {
            type: "string",
            enum: ["current", "any"],
            description:
              "`current` (default) filters to this workspace; `any` returns matches from every workspace the log has seen.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Max results (default 100).",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          ref: { type: "string" },
          count: { type: "integer" },
          commits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sha: { type: "string" },
                subject: { type: ["string", "null"] },
                linkType: { type: "string", enum: ["closes", "references"] },
                resolved: { type: "boolean" },
                issueState: { type: ["string", "null"] },
                workspace: { type: "string" },
                recordedAt: { type: "integer" },
              },
              required: [
                "sha",
                "linkType",
                "resolved",
                "workspace",
                "recordedAt",
              ],
            },
          },
        },
        required: ["ref", "count", "commits"],
      },
    },
    timeoutMs: 5_000,
    async handler(args: Record<string, unknown>) {
      const raw = optionalString(args, "issue");
      if (!raw) return error("issue is required");
      const numMatch = raw.match(/(\d+)/);
      if (!numMatch) return error(`invalid issue ref: '${raw}'`);
      const ref = `#${numMatch[1]}`;

      const linkType = optionalString(args, "linkType") as
        | LinkType
        | undefined
        | "";
      const scope = optionalString(args, "workspaceScope") ?? "current";
      const limit = optionalInt(args, "limit", 1, 500) ?? 100;

      const links = linkLog.query({
        ref,
        ...(linkType === "closes" || linkType === "references"
          ? { linkType }
          : {}),
        ...(scope === "current" ? { workspace } : {}),
        limit,
      });

      return successStructured({
        ref,
        count: links.length,
        commits: links.map((l) => ({
          sha: l.sha,
          subject: l.subject ?? null,
          linkType: l.linkType,
          resolved: l.resolved,
          issueState: l.issueState ?? null,
          workspace: l.workspace,
          recordedAt: l.createdAt,
        })),
      });
    },
  };
}
