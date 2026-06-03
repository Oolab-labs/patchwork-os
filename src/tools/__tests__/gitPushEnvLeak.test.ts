import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for audit 2026-06-03 (HIGH #1): createGitPushTool spread the full
// process.env into the git subprocess env, defeating execSafe's minimalEnv
// secret filter. A malicious remote's credential helper / GIT_SSH_COMMAND /
// hooks could then read ANTHROPIC_API_KEY, OAuth tokens, DB URLs, etc.
//
// We mock the git boundaries so the push code path is reached without a real
// remote, and capture the env object actually handed to runGit for the push.

let capturedPushEnv: NodeJS.ProcessEnv | undefined;

vi.mock("../git-utils.js", async (importActual) => {
  const actual = await importActual<typeof import("../git-utils.js")>();
  return {
    ...actual,
    checkGitRepo: vi.fn(async () => true),
    runGit: vi.fn(
      async (
        args: string[],
        _cwd: string,
        opts: { env?: NodeJS.ProcessEnv } = {},
      ) => {
        if (args[0] === "push") capturedPushEnv = opts.env;
        return { stdout: "", stderr: "" };
      },
    ),
  };
});

vi.mock("../utils.js", async (importActual) => {
  const actual = await importActual<typeof import("../utils.js")>();
  return {
    ...actual,
    // remote pre-flight + post-push rev-parse run through execSafe directly.
    execSafe: vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "remote")
        return { stdout: "origin\n", stderr: "", exitCode: 0, timedOut: false };
      if (args[0] === "rev-parse")
        return {
          stdout: "abcdef123456\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    }),
  };
});

const SECRET_CANARY = "do-not-leak-secret-canary";

describe("gitPush env isolation (audit HIGH #1)", () => {
  beforeEach(() => {
    capturedPushEnv = undefined;
    process.env.PATCHWORK_SECRET_CANARY = SECRET_CANARY;
  });
  afterEach(() => {
    delete process.env.PATCHWORK_SECRET_CANARY;
    vi.clearAllMocks();
  });

  it("does not leak arbitrary process.env secrets into the git push subprocess", async () => {
    const { createGitPushTool } = await import("../gitWrite.js");
    const tool = createGitPushTool("/tmp/fake-workspace");

    const result = await tool.handler({
      remote: "origin",
      branch: "feature-x",
    });

    expect(result.isError).toBeFalsy();
    expect(capturedPushEnv).toBeDefined();
    // The SSH option must still be set (the legitimate reason env is passed).
    expect(capturedPushEnv?.GIT_SSH_COMMAND).toContain("ConnectTimeout");
    // The secret canary present in process.env must NOT reach the subprocess.
    expect(capturedPushEnv?.PATCHWORK_SECRET_CANARY).toBeUndefined();
    // Sanity: the canary really is in the parent env (proving the test is live).
    expect(process.env.PATCHWORK_SECRET_CANARY).toBe(SECRET_CANARY);
  });
});
