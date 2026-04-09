/**
 * Cross-cutting test: every tool that declares outputSchema must return
 * structuredContent in its handler result, and it must equal the parsed
 * text content block (round-trip consistency).
 *
 * This guards against the drift pattern where outputSchema is declared but
 * the handler still calls success()/successLarge() instead of
 * successStructured()/successStructuredLarge().
 *
 * Covers the tools updated in v2.11.7–2.11.9: runTests, searchWorkspace,
 * getGitDiff, getBufferContent, generateTests, detectUnusedCode, getGitHotspots,
 * lsp.ts tools (getHover, applyCodeAction, searchWorkspaceSymbols), plus
 * v2.11.9 additions: getToolCapabilities, auditDependencies.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { createGetActivityLogTool } from "../activityLog.js";
import { createAuditDependenciesTool } from "../auditDependencies.js";
import { createDetectUnusedCodeTool } from "../detectUnusedCode.js";
import { createGenerateTestsTool } from "../generateTests.js";
import { createGetBufferContentTool } from "../getBufferContent.js";
import { createGetGitDiffTool } from "../getGitDiff.js";
import { createGetGitHotspotsTool } from "../getGitHotspots.js";
import { createGetProjectInfoTool } from "../getProjectInfo.js";
import { createGetToolCapabilitiesTool } from "../getToolCapabilities.js";
import {
  createApplyCodeActionTool,
  createGetHoverTool,
  createSearchWorkspaceSymbolsTool,
} from "../lsp.js";
import { createRunCommandTool } from "../runCommand.js";
import { createRunTestsTool } from "../runTests.js";
import { createSearchWorkspaceTool } from "../searchWorkspace.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);

const WORKSPACE = tmpdir();

/** Assert structuredContent is present and consistent with text content. */
function assertStructured(result: {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
}) {
  expect(result.structuredContent).toBeDefined();
  const parsed = JSON.parse(result.content[0]?.text ?? "{}");
  expect(result.structuredContent).toEqual(parsed);
}

function execOk(stdout = "", exitCode = 0) {
  return {
    stdout,
    stderr: "",
    exitCode,
    timedOut: false,
    durationMs: 5,
  };
}

describe("structuredContent contract", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── getGitHotspots ────────────────────────────────────────────────────────

  describe("getGitHotspots", () => {
    it("emits structuredContent on success", async () => {
      mockExecSafe
        .mockResolvedValueOnce(execOk("HEAD")) // rev-parse
        .mockResolvedValueOnce(execOk("src/a.ts\nsrc/a.ts\nsrc/b.ts\n")) // log
        .mockResolvedValueOnce(execOk("3")); // rev-list count
      const tool = createGetGitHotspotsTool(WORKSPACE);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── getGitDiff ────────────────────────────────────────────────────────────

  describe("getGitDiff", () => {
    it("emits structuredContent on success", async () => {
      mockExecSafe.mockResolvedValueOnce(execOk("diff --git a/f b/f\n+line"));
      const tool = createGetGitDiffTool(WORKSPACE);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── searchWorkspace ───────────────────────────────────────────────────────

  describe("searchWorkspace", () => {
    it("emits structuredContent when grep is used as fallback", async () => {
      // Force rg to fail so grep path is taken
      mockExecSafe
        .mockResolvedValueOnce(execOk("", 1)) // rg --version fails
        .mockResolvedValueOnce(execOk(`${WORKSPACE}/a.ts:1:match line\n`)); // grep
      const probes = { rg: false, tsc: false } as never;
      const tool = createSearchWorkspaceTool(WORKSPACE, probes);
      const result = await tool.handler({ query: "match" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── runTests ──────────────────────────────────────────────────────────────

  describe("runTests", () => {
    it("emits structuredContent when no runners detected", async () => {
      // No probes → no runners → available: false path
      const tool = createRunTestsTool(WORKSPACE, {
        rg: false,
        vitest: false,
        jest: false,
        pytest: false,
        cargo: false,
        go: false,
        tsc: false,
      } as never);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── detectUnusedCode ─────────────────────────────────────────────────────

  describe("detectUnusedCode", () => {
    it("emits structuredContent when no detector available", async () => {
      // npx tsc exits non-zero with no output → available: false
      mockExecSafe.mockResolvedValueOnce(execOk("", 1));
      const tool = createDetectUnusedCodeTool(WORKSPACE);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── generateTests ─────────────────────────────────────────────────────────

  describe("generateTests", () => {
    it("emits structuredContent for a TypeScript file", async () => {
      const fs = await import("node:fs/promises");
      const testFile = join(WORKSPACE, "_audit_test_stub.ts");
      await fs.writeFile(
        testFile,
        "export function hello() { return 1; }\n",
        "utf8",
      );
      try {
        const tool = createGenerateTestsTool(WORKSPACE);
        const result = await tool.handler({
          file: testFile,
          framework: "vitest",
        });
        assertStructured(result as Parameters<typeof assertStructured>[0]);
      } finally {
        await fs.unlink(testFile).catch(() => {});
      }
    });
  });

  // ── getBufferContent ──────────────────────────────────────────────────────

  describe("getBufferContent", () => {
    it("emits structuredContent reading a real file from disk", async () => {
      const fs = await import("node:fs/promises");
      const testFile = join(WORKSPACE, "_buf_content_stub.ts");
      await fs.writeFile(testFile, "const x = 1;\n", "utf8");
      try {
        const tool = createGetBufferContentTool(WORKSPACE);
        const result = await tool.handler({ filePath: testFile });
        assertStructured(result as Parameters<typeof assertStructured>[0]);
      } finally {
        await fs.unlink(testFile).catch(() => {});
      }
    });
  });

  // ── lsp.ts: getHover ──────────────────────────────────────────────────────

  describe("getHover (lsp.ts)", () => {
    it("emits structuredContent when extension returns null (not found)", async () => {
      const mockClient = {
        isConnected: () => true,
        isLspReady: () => true,
        getHover: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetHoverTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent when extension returns a hover result", async () => {
      const mockClient = {
        isConnected: () => true,
        isLspReady: () => true,
        getHover: vi
          .fn()
          .mockResolvedValue({ found: true, value: "string", range: null }),
      } as never;
      const tool = createGetHoverTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: applyCodeAction ───────────────────────────────────────────────

  describe("applyCodeAction (lsp.ts)", () => {
    it("emits structuredContent when action applied successfully", async () => {
      const mockClient = {
        isConnected: () => true,
        applyCodeAction: vi
          .fn()
          .mockResolvedValue({ applied: true, title: "Fix lint error" }),
      } as never;
      const tool = createApplyCodeActionTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 10,
        actionTitle: "Fix lint error",
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: searchWorkspaceSymbols ────────────────────────────────────────

  describe("searchWorkspaceSymbols (lsp.ts)", () => {
    it("emits structuredContent when extension returns null", async () => {
      const mockClient = {
        isConnected: () => true,
        isLspReady: () => true,
        searchSymbols: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createSearchWorkspaceSymbolsTool(WORKSPACE, mockClient);
      const result = await tool.handler({ query: "hello" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent with symbol results", async () => {
      const mockClient = {
        isConnected: () => true,
        isLspReady: () => true,
        searchSymbols: vi
          .fn()
          .mockResolvedValue({ symbols: [{ name: "hello" }], count: 1 }),
      } as never;
      const tool = createSearchWorkspaceSymbolsTool(WORKSPACE, mockClient);
      const result = await tool.handler({ query: "hello" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── getProjectInfo ────────────────────────────────────────────────────────

  describe("getProjectInfo", () => {
    it("emits structuredContent for the test workspace", async () => {
      const tool = createGetProjectInfoTool(WORKSPACE);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── getActivityLog ────────────────────────────────────────────────────────

  describe("getActivityLog", () => {
    it("emits structuredContent with empty log", async () => {
      const mockLog = {
        query: vi.fn().mockReturnValue([]),
        stats: vi.fn().mockReturnValue({}),
      } as never;
      const tool = createGetActivityLogTool(mockLog);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── runCommand ────────────────────────────────────────────────────────────

  describe("runCommand", () => {
    it("emits structuredContent for a successful command", async () => {
      mockExecSafe.mockResolvedValueOnce(execOk("hello"));
      const config = {
        workspace: WORKSPACE,
        commandAllowlist: ["echo"],
        commandTimeout: 30_000,
        maxResultSize: 512,
      } as never;
      const tool = createRunCommandTool(WORKSPACE, config);
      const result = await tool.handler({ command: "echo", args: ["hello"] });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── getToolCapabilities ───────────────────────────────────────────────────

  describe("getToolCapabilities", () => {
    it("emits structuredContent when extension is disconnected", async () => {
      const mockClient = {
        isConnected: () => false,
      } as never;
      const probes = {
        rg: false,
        fd: false,
        git: false,
        codex: false,
        tsc: false,
        eslint: false,
        pyright: false,
        ruff: false,
        cargo: false,
        go: false,
        biome: false,
        prettier: false,
        black: false,
        gofmt: false,
        rustfmt: false,
        vitest: false,
        jest: false,
        pytest: false,
        gh: false,
      } as never;
      const config = { commandAllowlist: [], editorCommand: null } as never;
      const tool = createGetToolCapabilitiesTool(probes, mockClient, config);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── auditDependencies ─────────────────────────────────────────────────────

  describe("auditDependencies", () => {
    it("emits structuredContent when no manifest found", async () => {
      // Use a temp dir with no package files so detected manager is null
      const tool = createAuditDependenciesTool(WORKSPACE);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });
});
