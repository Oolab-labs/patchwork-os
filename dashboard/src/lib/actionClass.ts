/**
 * Client-side mirror of the bridge's `classifyActionClass`
 * (repo-root `src/workers/actionClass.ts`). The dashboard is a separate
 * Next.js app with its own tsconfig/build and does not import from the
 * bridge's `src/` directly (no existing cross-import pattern — checked
 * before adding this file). This is a deliberately small, honestly-labeled
 * PORT of the reversibility mapping, not a full copy of the module (it
 * omits `outcomeWeight`/`reachableLevels`, which are trust-ramp math the
 * dashboard doesn't need here).
 *
 * MAY DRIFT from the bridge source over time — if you add a new tool
 * domain there, mirror it here too. Keep in sync with
 * `DOMAIN_BY_TOOL` / `REVERSIBILITY_BY_DOMAIN` in
 * `src/workers/actionClass.ts`.
 */

export type Reversibility = "reversible" | "compensable" | "irreversible";

const DOMAIN_BY_TOOL: Record<string, string> = {
  getGitStatus: "vcs-read",
  getGitDiff: "vcs-read",
  getGitLog: "vcs-read",
  gitBlame: "vcs-read",
  gitListBranches: "vcs-read",
  gitAdd: "vcs-local",
  gitCommit: "vcs-local",
  gitCheckout: "vcs-local",
  gitStash: "vcs-local",
  gitPush: "vcs-push",
  githubCreatePR: "vcs-remote",
  githubMergePR: "vcs-merge",
  editText: "fs-write",
  searchAndReplace: "fs-write",
  createFile: "fs-write",
  formatDocument: "fs-write",
  getBufferContent: "fs-read",
  findFiles: "fs-read",
  runCommand: "shell",
  runInTerminal: "shell",
  sendTerminalCommand: "shell",
  slackPostMessage: "messaging",
  sendHttpRequest: "http",
  WebFetch: "http",
  githubCreateIssue: "issue",
  createLinearIssue: "issue",
  addLinearComment: "issue",
  updateLinearIssue: "issue",
  runTests: "ci",
  githubActions: "ci",
  auditDependencies: "deps-read",
  getSecurityAdvisories: "deps-read",
  "git.log_since": "vcs-read",
  "git.stale_branches": "vcs-read",
  "github.list_commits": "vcs-read",
  "github.list_prs": "vcs-read",
  "github.list_issues": "vcs-read",
  "github.create_issue": "issue",
  "file.read": "fs-read",
  "file.write": "fs-write",
  "file.append": "fs-write",
  "slack.post_message": "messaging",
  "http.post": "http",
  "linear.list_issues": "issue-read",
  "sentry.get_issue": "issue-read",
  "diagnostics.get": "fs-read",
  // Editor tool names that appear in the approvals queue (CC-native, not
  // MCP-namespaced — not present in the bridge's DOMAIN_BY_TOOL, which is
  // keyed on MCP/recipe tool ids). Mapped conservatively by behavior.
  Bash: "shell",
  Read: "fs-read",
  Edit: "fs-write",
  Write: "fs-write",
  MultiEdit: "fs-write",
  Glob: "fs-read",
  Grep: "fs-read",
};

const REVERSIBILITY_BY_DOMAIN: Record<string, Reversibility> = {
  "vcs-read": "reversible",
  "vcs-local": "reversible",
  "vcs-remote": "compensable",
  "vcs-push": "compensable",
  "vcs-merge": "compensable",
  "fs-write": "reversible",
  "fs-read": "reversible",
  shell: "irreversible",
  messaging: "irreversible",
  http: "irreversible",
  issue: "compensable",
  "issue-read": "reversible",
  ci: "reversible",
  "deps-read": "reversible",
};

/** Plain names for the badge/sentence. Mirrors DOMAIN_LABELS conventions
 * used on the /workers page (kept separate — small, page-scoped list). */
export const DOMAIN_PLAIN_NAME: Record<string, string> = {
  "vcs-read": "reading code history",
  "vcs-local": "a local commit",
  "vcs-remote": "opening a pull request",
  "vcs-push": "pushing to a remote",
  "vcs-merge": "merging code",
  "fs-write": "changing a file",
  "fs-read": "reading a file",
  shell: "running a shell command",
  messaging: "sending a message",
  http: "an outbound network call",
  issue: "filing an issue",
  "issue-read": "reading an issue",
  ci: "running tests / CI",
  "deps-read": "checking dependencies",
};

/** One honest, non-alarmist consequence sentence per domain — "if it's
 * wrong" copy for the right rail. Deliberately short and concrete. */
export const CONSEQUENCE_IF_WRONG: Record<string, string> = {
  "vcs-read": "no side effect — nothing changes.",
  "vcs-local": "a bad local commit can be reset or amended.",
  "vcs-remote": "an opened PR can be closed without merging.",
  "vcs-push": "a bad push can be force-reverted.",
  "vcs-merge": "a bad merge needs a follow-up revert PR.",
  "fs-write": "a bad edit can be undone from the file's history.",
  "fs-read": "no side effect — nothing changes.",
  shell: "an arbitrary command's side effects may not be undoable.",
  messaging: "a sent message can't be unsent, only followed up.",
  http: "an outbound POST may not be undoable on the other end.",
  issue: "a filed issue can be closed.",
  "issue-read": "no side effect — nothing changes.",
  ci: "re-runnable, no durable side effect.",
  "deps-read": "no side effect — nothing changes.",
};

export interface ClientActionClass {
  key: string;
  domain: string;
  reversibility: Reversibility;
}

/**
 * Classify a pending approval's tool into an action class. Returns `null`
 * when the tool is unrecognized — callers MUST render this as
 * "unclassified", never guess/default to a reversibility tier. This is the
 * one behavioral difference from the bridge's `classifyActionClass`, which
 * defaults unknown tools to `other:irreversible` for its own (conservative,
 * gate-blocking) purposes — the dashboard's job here is honest disclosure,
 * not gating, so guessing "irreversible" for an unknown tool would be a
 * fabricated claim about a specific action, not a safe default.
 */
export function classifyPendingAction(toolName: string): ClientActionClass | null {
  const domain = DOMAIN_BY_TOOL[toolName];
  if (!domain) return null;
  const reversibility = REVERSIBILITY_BY_DOMAIN[domain] ?? "compensable";
  return { key: `${domain}::${reversibility}`, domain, reversibility };
}

/** Sort rank: irreversible first, then compensable, then reversible;
 * unclassified sorts with reversible (least alarming default placement —
 * documented choice, see approvals/page.tsx sort comment). */
export function reversibilityRank(r: Reversibility | undefined): number {
  if (r === "irreversible") return 0;
  if (r === "compensable") return 1;
  return 2; // reversible or unclassified
}
