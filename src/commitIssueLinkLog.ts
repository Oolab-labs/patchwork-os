import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

/**
 * CommitIssueLinkLog — persistent audit trail of every commit→issue link
 * extracted by the `enrichCommit` tool.
 *
 * Mirrors RecipeRunLog: JSONL append-only file + bounded in-memory ring.
 * Schema is additive; consumers must tolerate unknown keys. Enables reverse
 * queries ("which commits touch issue #42?") without re-running enrichment.
 */

export type LinkType = "closes" | "references";

export interface CommitIssueLink {
  /** Monotonic sequence id within the process — stable for pagination. */
  seq: number;
  /** Commit SHA (full). */
  sha: string;
  /** Normalized issue ref, e.g. `#42`. */
  ref: string;
  /** Classification from commit-message verb proximity. */
  linkType: LinkType;
  /** Whether the issue was successfully fetched from the issue tracker. */
  resolved: boolean;
  /** Workspace that produced the link — lets one log span many repos. */
  workspace: string;
  /** Commit subject (first line of message), for display. */
  subject?: string;
  /** Issue state at the time the link was recorded (`OPEN`/`CLOSED`/…). */
  issueState?: string;
  /** Issue title at the time the link was recorded. */
  issueTitle?: string;
  /** Reason the link is unresolved (not_found / gh_unavailable / error / auth). */
  reason?: string;
  /** ms epoch when the link was recorded. */
  createdAt: number;
}

const DEFAULT_MEMORY_CAP = 2_000;

export interface LinkLogOptions {
  /** Directory holding commit_issue_links.jsonl. Created if missing. */
  dir: string;
  logger?: Logger;
  /** Cap on in-memory ring. File is not truncated. */
  memoryCap?: number;
  /** Test hook — default Date.now. */
  now?: () => number;
}

export interface LinkQuery {
  /** Filter by commit SHA (exact or prefix ≥7 chars). */
  sha?: string;
  /** Filter by issue ref (`#42`). */
  ref?: string;
  /** Filter by workspace path. */
  workspace?: string;
  linkType?: LinkType;
  resolved?: boolean;
  /** Links with seq > after. */
  after?: number;
  limit?: number;
}

export class CommitIssueLinkLog {
  private links: CommitIssueLink[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly memoryCap: number;
  private readonly now: () => number;

  constructor(private readonly opts: LinkLogOptions) {
    this.file = path.join(opts.dir, "commit_issue_links.jsonl");
    this.memoryCap = opts.memoryCap ?? DEFAULT_MEMORY_CAP;
    this.now = opts.now ?? Date.now;
    try {
      mkdirSync(opts.dir, { recursive: true });
    } catch (err) {
      opts.logger?.warn?.(
        `[linklog] could not create ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.loadExisting();
  }

  /**
   * Record one link. De-duplicates against the most recent existing row for
   * the same (workspace, sha, ref) — identical repeat calls don't grow the
   * log. A row whose `resolved` flag or `issueState` changes IS appended, so
   * the history of an issue's state across commits stays visible.
   */
  record(
    input: Omit<CommitIssueLink, "seq" | "createdAt">,
  ): CommitIssueLink | null {
    const prev = this.findMostRecent(input.workspace, input.sha, input.ref);
    if (
      prev &&
      prev.linkType === input.linkType &&
      prev.resolved === input.resolved &&
      prev.issueState === input.issueState &&
      prev.reason === input.reason
    ) {
      return null;
    }
    this.seq += 1;
    const link: CommitIssueLink = {
      seq: this.seq,
      sha: input.sha,
      ref: input.ref,
      linkType: input.linkType,
      resolved: input.resolved,
      workspace: input.workspace,
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.issueState !== undefined && { issueState: input.issueState }),
      ...(input.issueTitle !== undefined && { issueTitle: input.issueTitle }),
      ...(input.reason !== undefined && { reason: input.reason }),
      createdAt: this.now(),
    };
    this.links.push(link);
    if (this.links.length > this.memoryCap) {
      this.links.splice(0, this.links.length - this.memoryCap);
    }
    this.append(link);
    return link;
  }

  query(q: LinkQuery = {}): CommitIssueLink[] {
    let out = this.links;
    if (q.sha) {
      const needle = q.sha;
      out = out.filter(
        (l) =>
          l.sha === needle || (needle.length >= 7 && l.sha.startsWith(needle)),
      );
    }
    if (q.ref) out = out.filter((l) => l.ref === q.ref);
    if (q.workspace) out = out.filter((l) => l.workspace === q.workspace);
    if (q.linkType) out = out.filter((l) => l.linkType === q.linkType);
    if (q.resolved !== undefined) {
      const wanted = q.resolved;
      out = out.filter((l) => l.resolved === wanted);
    }
    if (q.after !== undefined) {
      const after = q.after;
      out = out.filter((l) => l.seq > after);
    }
    out = [...out].sort((a, b) => b.seq - a.seq);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1_000);
    return out.slice(0, limit);
  }

  size(): number {
    return this.links.length;
  }

  private findMostRecent(
    workspace: string,
    sha: string,
    ref: string,
  ): CommitIssueLink | undefined {
    for (let i = this.links.length - 1; i >= 0; i -= 1) {
      const l = this.links[i];
      if (l && l.workspace === workspace && l.sha === sha && l.ref === ref) {
        return l;
      }
    }
    return undefined;
  }

  private append(link: CommitIssueLink): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(link)}\n`, { mode: 0o600 });
    } catch (err) {
      this.opts.logger?.warn?.(
        `[linklog] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private loadExisting(): void {
    try {
      statSync(this.file);
    } catch {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf-8");
    } catch (err) {
      this.opts.logger?.warn?.(
        `[linklog] read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as CommitIssueLink;
        if (
          typeof parsed.seq !== "number" ||
          typeof parsed.sha !== "string" ||
          typeof parsed.ref !== "string"
        ) {
          continue;
        }
        this.links.push(parsed);
        if (parsed.seq > this.seq) this.seq = parsed.seq;
      } catch {
        // skip malformed line
      }
    }
    if (this.links.length > this.memoryCap) {
      this.links.splice(0, this.links.length - this.memoryCap);
    }
  }
}
