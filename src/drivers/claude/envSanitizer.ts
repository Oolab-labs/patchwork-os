/**
 * Strip env vars that would cause the subprocess to attach to or authenticate
 * as the parent Claude Code session.
 *
 * `CLAUDECODE` and most `CLAUDE_CODE_*` / `MCP_*` vars are set by a running
 * Claude Code session for its child processes and would make the spawned
 * subprocess re-authenticate against, or behave as a nested agent of, that
 * parent.
 *
 * EXCEPTION: `CLAUDE_CODE_OAUTH_TOKEN` is the official long-lived
 * subscription auth env (issued by `claude setup-token`). Stripping it would
 * de-authenticate the subprocess entirely — recipes running under a
 * subscription would all fail with "Not logged in · Please run /login".
 * Preserve it.
 *
 * This fix was originally shipped in PR #777 but was lost in the squash-merge
 * (see chore(release) commit aa89d0de touching this file). Re-applied here.
 */
const PRESERVE = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(clean)) {
    if (PRESERVE.has(key)) continue;
    if (
      key === "CLAUDECODE" ||
      key.startsWith("CLAUDE_CODE_") ||
      key.startsWith("MCP_")
    ) {
      delete clean[key];
    }
  }
  return clean;
}
