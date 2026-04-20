/**
 * Strip env vars that would cause the subprocess to attach to or authenticate
 * as the parent Claude Code session.
 * Any of CLAUDECODE, CLAUDE_CODE_*, or MCP_* can cause the subprocess to
 * re-authenticate against, or behave as a nested agent of, the parent session.
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(clean)) {
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
