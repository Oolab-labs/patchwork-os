import { runGitStdout } from "./git-utils.js";
import { GH_NOT_AUTHED, isNotAuthed, isNotFound } from "./github/shared.js";
import { classifyIssueLink, extractIssueRefs } from "./issueRefs.js";
import { error, execSafe, optionalString, successStructured } from "./utils.js";

/**
 * Fetch a single issue via `gh issue view --json`. Returns `null` if the
 * issue doesn't exist (not an auth error) — callers treat missing issues
 * as unresolved, not fatal.
 */
async function fetchIssue(
  workspace: string,
  number: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; issue: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "not_authed" | "error"; detail: string }
> {
  const result = await execSafe(
    "gh",
    [
      "issue",
      "view",
      number,
      "--json",
      "number,title,state,url,labels,assignees",
    ],
    { cwd: workspace, signal, timeout: 30_000 },
  );
  if (result.exitCode === 0) {
    try {
      return { ok: true, issue: JSON.parse(result.stdout.trim()) };
    } catch {
      return {
        ok: false,
        reason: "error",
        detail: `parse failed: ${result.stdout.trim().slice(0, 200)}`,
      };
    }
  }
  const msg = result.stderr.trim() || result.stdout.trim();
  if (isNotAuthed(msg)) return { ok: false, reason: "not_authed", detail: msg };
  if (isNotFound(msg) || /not found|could not resolve/i.test(msg)) {
    return { ok: false, reason: "not_found", detail: msg };
  }
  return { ok: false, reason: "error", detail: msg };
}

export function createEnrichCommitTool(workspace: string) {
  return {
    schema: {
      name: "enrichCommit",
      description:
        "Enrich commit w/ linked issues. Parses #N / GH-N refs from message, fetches issue state via gh, classifies close vs ref. Missing issues flagged unresolved — not errors.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          ref: {
            type: "string",
            description:
              "Commit SHA or ref. Defaults to HEAD. Passed through to `git show`.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          sha: { type: "string" },
          subject: { type: "string" },
          author: { type: "string" },
          date: { type: "string" },
          issueRefs: { type: "array", items: { type: "string" } },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                linkType: { type: "string", enum: ["closes", "references"] },
                resolved: { type: "boolean" },
                issue: { type: ["object", "null"] },
                reason: { type: ["string", "null"] },
              },
              required: ["ref", "linkType", "resolved"],
            },
          },
          unresolved: { type: "integer" },
          ghAvailable: { type: "boolean" },
        },
        required: [
          "sha",
          "subject",
          "issueRefs",
          "links",
          "unresolved",
          "ghAvailable",
        ],
      },
    },
    timeoutMs: 45_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const ref = optionalString(args, "ref") ?? "HEAD";

      // Verify git repo
      const check = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: workspace,
        signal,
        timeout: 5_000,
      });
      if (check.exitCode !== 0) return error("Not a git repository");

      let showOut: string;
      try {
        showOut = await runGitStdout(
          [
            "show",
            "--no-patch",
            "--format=%H%n%an <%ae>%n%aI%n%s%n---BODY---%n%B",
            ref,
          ],
          workspace,
          { signal, timeout: 10_000 },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return error(`Failed to read commit '${ref}': ${msg}`);
      }

      const [metaPart, bodyPart = ""] = showOut.split("\n---BODY---\n", 2);
      const metaLines = (metaPart ?? "").split("\n");
      const sha = metaLines[0] ?? "";
      const author = metaLines[1] ?? "";
      const date = metaLines[2] ?? "";
      const subject = metaLines[3] ?? "";
      const fullMessage = bodyPart.trim() || subject;

      const issueRefs = extractIssueRefs(fullMessage);

      // Probe gh availability once — if the tool is missing, skip all fetches.
      const probe = await execSafe("gh", ["--version"], {
        cwd: workspace,
        signal,
        timeout: 5_000,
      });
      const ghAvailable = probe.exitCode === 0;

      const links: Array<Record<string, unknown>> = [];
      let unresolved = 0;

      for (const r of issueRefs) {
        const linkType = classifyIssueLink(fullMessage, r);
        if (!ghAvailable) {
          links.push({
            ref: r,
            linkType,
            resolved: false,
            issue: null,
            reason: "gh_unavailable",
          });
          unresolved += 1;
          continue;
        }
        const num = r.replace(/^#/, "");
        const fetched = await fetchIssue(workspace, num, signal);
        if (fetched.ok) {
          links.push({
            ref: r,
            linkType,
            resolved: true,
            issue: fetched.issue,
            reason: null,
          });
        } else {
          links.push({
            ref: r,
            linkType,
            resolved: false,
            issue: null,
            reason:
              fetched.reason === "not_authed" ? GH_NOT_AUTHED : fetched.reason,
          });
          unresolved += 1;
        }
      }

      return successStructured({
        sha,
        subject,
        author,
        date,
        issueRefs,
        links,
        unresolved,
        ghAvailable,
      });
    },
  };
}
