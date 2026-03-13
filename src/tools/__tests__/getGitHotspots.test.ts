import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { execSafe } from "../utils.js";
import { createGetGitHotspotsTool } from "../getGitHotspots.js";

const mockExecSafe = vi.mocked(execSafe);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 10 };
}

const WORKSPACE = "/tmp/test-ws";

const GIT_LOG_OUTPUT = `
src/transport.ts
src/transport.ts
src/tools/getDiagnostics.ts
src/transport.ts
src/bridge.ts
src/tools/getDiagnostics.ts
`;

describe("getGitHotspots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when not a git repo", async () => {
    mockExecSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "not a git repo",
      exitCode: 128,
      timedOut: false,
      durationMs: 10,
    });

    const tool = createGetGitHotspotsTool(WORKSPACE);
    const result = await tool.handler({});
    expect(result.content[0]?.text).toContain("Not a git repository");
  });

  it("returns ranked hotspots", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git")) // rev-parse
      .mockResolvedValueOnce(ok(GIT_LOG_OUTPUT)) // git log
      .mockResolvedValueOnce(ok("42")); // rev-list --count

    const tool = createGetGitHotspotsTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.hotspots).toHaveLength(3);
    expect(result.hotspots[0].file).toBe("src/transport.ts");
    expect(result.hotspots[0].commits).toBe(3);
    expect(result.hotspots[0].rank).toBe(1);
    expect(result.totalCommitsScanned).toBe(42);
  });

  it("respects limit arg", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(ok(GIT_LOG_OUTPUT))
      .mockResolvedValueOnce(ok("10"));

    const tool = createGetGitHotspotsTool(WORKSPACE);
    const result = parse(await tool.handler({ limit: 2 }));
    expect(result.hotspots).toHaveLength(2);
  });

  it("returns error on git log timeout", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: true,
        durationMs: 15000,
      });

    const tool = createGetGitHotspotsTool(WORKSPACE);
    const result = await tool.handler({});
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("includes scopedTo when path arg provided", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(ok("src/transport.ts\n"))
      .mockResolvedValueOnce(ok("5"));

    const tool = createGetGitHotspotsTool(WORKSPACE);
    const result = parse(await tool.handler({ path: "src/" }));
    expect(result.scopedTo).toBe("src/");
  });
});
