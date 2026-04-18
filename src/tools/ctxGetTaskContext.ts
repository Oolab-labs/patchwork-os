import type { CommitIssueLinkLog } from "../commitIssueLinkLog.js";
import { runGitStdout } from "./git-utils.js";
import {
  GH_NOT_AUTHED,
  GH_NOT_FOUND,
  isNotAuthed,
  isNotFound,
} from "./github/shared.js";
import { extractIssueRefs } from "./issueRefs.js";
import {
  execSafe,
  optionalInt,
  requireString,
  successStructured,
} from "./utils.js";

/**
 * Unified task-context resolver advertised in the MCP handshake as
 * `ctxGetTaskContext(ref)`. Detects the ref type (`#42` / `GH-42` → issue,
 * `PR-42` / `pull/42` → PR, 7+ hex → commit) and composes existing tools
 * to return one structured view:
 *
 *   {
 *     ref, refType,
 *     issue?: { number, title, state, url, body?, labels?, assignees? },
 *     pullRequest?: { number, title, state, url, body? },
 *     commit?: { sha, author, date, subject, body, files? },
 *     linkedCommits?: [{ sha, subject, linkType, resolved }],
 *     related?: { recent: [{ref, subject, sha}] }
 *   }
 *
 * Fail-soft: missing `gh`, non-git workspace, unresolved ref → flagged in
 * output, never thrown. Agents can reason over a partial context.
 */

export interface CtxTaskContextDeps {
  workspace: string;
  commitIssueLinkLog?: CommitIssueLinkLog | null;
}

export type RefType = "issue" | "pull_request" | "commit" | "unknown";

function detectRefType(raw: string): { type: RefType; id: string } {
  const trimmed = raw.trim();
  // PR forms: `PR-42`, `pull/42`, `pr/42`, `#PR42`
  const pr = trimmed.match(/^(?:PR-|pull\/|pr\/|#PR)(\d+)$/i);
  if (pr?.[1]) return { type: "pull_request", id: pr[1] };

  // Issue forms: `#42`, `GH-42`, bare `42` (treat 1-5 digit numbers as issues)
  const issue = trimmed.match(/^(?:GH-|#)?(\d{1,5})$/i);
  if (issue?.[1]) return { type: "issue", id: issue[1] };

  // Commit: 7-40 hex chars
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    return { type: "commit", id: trimmed };
  }

  return { type: "unknown", id: trimmed };
}

async function fetchGhJson(
  workspace: string,
  args: string[],
  signal?: AbortSignal,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "not_authed" | "error"; detail: string }
> {
  const r = await execSafe("gh", args, {
    cwd: workspace,
    signal,
    timeout: 15_000,
  });
  if (r.exitCode === 0) {
    try {
      return { ok: true, data: JSON.parse(r.stdout.trim()) };
    } catch {
      return {
        ok: false,
        reason: "error",
        detail: "unparseable gh output",
      };
    }
  }
  const msg = r.stderr.trim() || r.stdout.trim();
  if (isNotAuthed(msg)) return { ok: false, reason: "not_authed", detail: msg };
  if (isNotFound(msg) || /not found|could not resolve/i.test(msg)) {
    return { ok: false, reason: "not_found", detail: msg };
  }
  return { ok: false, reason: "error", detail: msg };
}

async function fetchCommit(
  workspace: string,
  sha: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    const out = await runGitStdout(
      [
        "show",
        "--stat",
        "--format=%H%n%an <%ae>%n%aI%n%s%n---BODY---%n%B%n---END---",
        sha,
      ],
      workspace,
      { signal, timeout: 5_000 },
    );
    const [metaAndStat, , afterEnd = ""] = out.split(/\n---(?:BODY|END)---\n/);
    void afterEnd;
    const parts = out.split("\n---BODY---\n");
    const metaPart = parts[0] ?? "";
    const rest = parts[1] ?? "";
    const bodyParts = rest.split("\n---END---\n");
    const body = bodyParts[0] ?? "";
    const stat = (bodyParts[1] ?? "").trim();
    void metaAndStat;

    const [fullSha, author, date, subject] = metaPart.split("\n");
    if (!fullSha) return null;
    return {
      sha: fullSha,
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
      body: body.trim(),
      stat,
    };
  } catch {
    return null;
  }
}

export function createCtxGetTaskContextTool(deps: CtxTaskContextDeps) {
  return {
    schema: {
      name: "ctxGetTaskContext",
      description:
        "Unified context for any issue / PR / commit / error ref. Auto-detects ref type (#42, PR-42, sha) and composes issue + linked commits + related traces. Prefer over raw gh / git tools.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["ref"],
        properties: {
          ref: {
            type: "string",
            description:
              "Issue (`#42` / `GH-42`), PR (`PR-42` / `pull/42`), or commit SHA (7-40 hex). Whitespace-trimmed.",
          },
          maxLinkedCommits: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Cap on linked-commits section. Default 10.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          ref: { type: "string" },
          refType: {
            type: "string",
            enum: ["issue", "pull_request", "commit", "unknown"],
          },
          issue: { type: ["object", "null"] },
          pullRequest: { type: ["object", "null"] },
          commit: { type: ["object", "null"] },
          linkedCommits: { type: "array" },
          sources: {
            type: "object",
            properties: {
              gh: { type: "boolean" },
              git: { type: "boolean" },
              linkLog: { type: "boolean" },
            },
          },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["ref", "refType", "sources", "warnings"],
      },
    },
    timeoutMs: 30_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const rawRef = requireString(args, "ref", 256);
      const maxLinked = optionalInt(args, "maxLinkedCommits", 1, 50) ?? 10;
      const { type: refType, id } = detectRefType(rawRef);

      const warnings: string[] = [];
      const ghProbe = await execSafe("gh", ["--version"], {
        cwd: deps.workspace,
        signal,
        timeout: 3_000,
      });
      const ghAvailable = ghProbe.exitCode === 0;
      const gitProbe = await execSafe("git", ["rev-parse", "--git-dir"], {
        cwd: deps.workspace,
        signal,
        timeout: 3_000,
      });
      const gitAvailable = gitProbe.exitCode === 0;

      const sources = {
        gh: ghAvailable,
        git: gitAvailable,
        linkLog: Boolean(deps.commitIssueLinkLog),
      };

      let issue: Record<string, unknown> | null = null;
      let pullRequest: Record<string, unknown> | null = null;
      let commit: Record<string, unknown> | null = null;
      let linkedCommits: Array<Record<string, unknown>> = [];

      if (refType === "unknown") {
        warnings.push(
          `could not detect ref type for '${rawRef}' — expected issue (#42), PR (PR-42), or commit SHA`,
        );
        return successStructured({
          ref: rawRef,
          refType,
          issue,
          pullRequest,
          commit,
          linkedCommits,
          sources,
          warnings,
        });
      }

      // Issue path: fetch the issue, then look up linked commits from the
      // persistent enrichment log. Falls back silently if gh unavailable.
      if (refType === "issue") {
        if (ghAvailable) {
          const fetched = await fetchGhJson(
            deps.workspace,
            [
              "issue",
              "view",
              id,
              "--json",
              "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt",
            ],
            signal,
          );
          if (fetched.ok) {
            issue = fetched.data;
          } else {
            warnings.push(
              `issue ${id}: ${fetched.reason === "not_authed" ? GH_NOT_AUTHED : fetched.reason === "not_found" ? GH_NOT_FOUND : fetched.detail}`,
            );
          }
        } else {
          warnings.push("gh CLI unavailable — issue details skipped");
        }

        if (deps.commitIssueLinkLog) {
          const refKey = `#${id}`;
          const links = deps.commitIssueLinkLog.query({
            ref: refKey,
            workspace: deps.workspace,
            limit: maxLinked,
          });
          linkedCommits = links.map((l) => ({
            sha: l.sha,
            subject: l.subject ?? null,
            linkType: l.linkType,
            resolved: l.resolved,
            issueState: l.issueState ?? null,
            recordedAt: l.createdAt,
          }));
        }
      }

      // PR path: fetch PR metadata + extract issue refs from the body so
      // the agent sees "this PR closes #42" without a second call.
      if (refType === "pull_request") {
        if (ghAvailable) {
          const fetched = await fetchGhJson(
            deps.workspace,
            [
              "pr",
              "view",
              id,
              "--json",
              "number,title,state,url,body,author,baseRefName,headRefName,mergeCommit",
            ],
            signal,
          );
          if (fetched.ok) {
            pullRequest = fetched.data;
            const body =
              typeof fetched.data.body === "string" ? fetched.data.body : "";
            const refs = extractIssueRefs(body);
            if (refs.length > 0) {
              pullRequest.linkedIssueRefs = refs;
            }
          } else {
            warnings.push(
              `PR ${id}: ${fetched.reason === "not_authed" ? GH_NOT_AUTHED : fetched.reason === "not_found" ? GH_NOT_FOUND : fetched.detail}`,
            );
          }
        } else {
          warnings.push("gh CLI unavailable — PR details skipped");
        }
      }

      // Commit path: git show + reverse-lookup which issues this commit touches.
      if (refType === "commit") {
        if (gitAvailable) {
          commit = await fetchCommit(deps.workspace, id, signal);
          if (!commit) {
            warnings.push(`commit ${id}: not found in repo`);
          }
        } else {
          warnings.push("not a git repository — commit details skipped");
        }

        if (deps.commitIssueLinkLog && commit?.sha) {
          const links = deps.commitIssueLinkLog.query({
            sha: String(commit.sha),
            workspace: deps.workspace,
            limit: maxLinked,
          });
          // Reverse direction: from this commit, which issues did it touch?
          if (links.length > 0) {
            commit.linkedIssues = links.map((l) => ({
              ref: l.ref,
              linkType: l.linkType,
              resolved: l.resolved,
              issueState: l.issueState ?? null,
            }));
          }
        }
      }

      return successStructured({
        ref: rawRef,
        refType,
        issue,
        pullRequest,
        commit,
        linkedCommits,
        sources,
        warnings,
      });
    },
  };
}
