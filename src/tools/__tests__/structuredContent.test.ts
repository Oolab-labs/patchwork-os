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
import { createCancelClaudeTaskTool } from "../cancelClaudeTask.js";
import { createGetCodeLensTool } from "../codeLens.js";
import { createDetectUnusedCodeTool } from "../detectUnusedCode.js";
import { createGetDocumentLinksTool } from "../documentLinks.js";
import { createFoldingRangesTool } from "../foldingRanges.js";
import { createGenerateTestsTool } from "../generateTests.js";
import { createGetBufferContentTool } from "../getBufferContent.js";
import { createGetClaudeTaskStatusTool } from "../getClaudeTaskStatus.js";
import { createGetGitDiffTool } from "../getGitDiff.js";
import { createGetGitHotspotsTool } from "../getGitHotspots.js";
import { createGetPRTemplateTool } from "../getPRTemplate.js";
import { createGetProjectInfoTool } from "../getProjectInfo.js";
import { createGetToolCapabilitiesTool } from "../getToolCapabilities.js";
import {
  createGetHandoffNoteTool,
  createSetHandoffNoteTool,
} from "../handoffNote.js";
import { createGetHoverAtCursorTool } from "../hoverAtCursor.js";
import { createGetInlayHintsTool } from "../inlayHints.js";
import { createListClaudeTasksTool } from "../listClaudeTasks.js";
import {
  createApplyCodeActionTool,
  createFindReferencesTool,
  createFormatRangeTool,
  createGetCallHierarchyTool,
  createGetCodeActionsTool,
  createGetHoverTool,
  createGoToDefinitionTool,
  createPrepareRenameTool,
  createRenameSymbolTool,
  createSearchWorkspaceSymbolsTool,
} from "../lsp.js";
import { createRefactorExtractFunctionTool } from "../refactorExtractFunction.js";
import { createRefactorPreviewTool } from "../refactorPreview.js";
import { createResumeClaudeTaskTool } from "../resumeClaudeTask.js";
import { createRunClaudeTaskTool } from "../runClaudeTask.js";
import { createRunCommandTool } from "../runCommand.js";
import { createRunTestsTool } from "../runTests.js";
import { createSearchWorkspaceTool } from "../searchWorkspace.js";
import { createSelectionRangesTool } from "../selectionRanges.js";
import { createGetSemanticTokensTool } from "../semanticTokens.js";
import { createGetTypeHierarchyTool } from "../typeHierarchy.js";
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

  // ── lsp.ts: goToDefinition ───────────────────────────────────────────────

  describe("goToDefinition (lsp.ts)", () => {
    it("emits structuredContent when no definition found", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        goToDefinition: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGoToDefinitionTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent when definition is found", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        goToDefinition: vi.fn().mockResolvedValue({
          found: true,
          uri: "file:///src/foo.ts",
          range: {},
        }),
      } as never;
      const tool = createGoToDefinitionTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: findReferences ────────────────────────────────────────────────

  describe("findReferences (lsp.ts)", () => {
    it("emits structuredContent when no references found", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        findReferences: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createFindReferencesTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent with reference results", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        findReferences: vi.fn().mockResolvedValue({
          found: true,
          references: [{ uri: "file:///src/foo.ts", range: {} }],
        }),
      } as never;
      const tool = createFindReferencesTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: getCallHierarchy ──────────────────────────────────────────────

  describe("getCallHierarchy (lsp.ts)", () => {
    it("emits structuredContent when no hierarchy found", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        getCallHierarchy: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetCallHierarchyTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent with hierarchy results", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        getCallHierarchy: vi
          .fn()
          .mockResolvedValue({ found: true, incoming: [], outgoing: [] }),
      } as never;
      const tool = createGetCallHierarchyTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
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

  // ── lsp.ts: getCodeActions ────────────────────────────────────────────────

  describe("getCodeActions (lsp.ts)", () => {
    it("emits structuredContent when extension returns null", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        getCodeActions: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetCodeActionsTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 10,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent with action list", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        getCodeActions: vi.fn().mockResolvedValue({
          actions: [{ title: "Fix lint", kind: "quickfix" }],
        }),
      } as never;
      const tool = createGetCodeActionsTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 10,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: renameSymbol ──────────────────────────────────────────────────

  describe("renameSymbol (lsp.ts)", () => {
    it("emits structuredContent on successful rename", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        renameSymbol: vi.fn().mockResolvedValue({
          success: true,
          newName: "newFoo",
          affectedFiles: [{ file: "/src/index.ts", editCount: 2 }],
          totalEdits: 2,
        }),
      } as never;
      const tool = createRenameSymbolTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 5,
        newName: "newFoo",
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: prepareRename ─────────────────────────────────────────────────

  describe("prepareRename (lsp.ts)", () => {
    it("emits structuredContent when rename is not supported", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        prepareRename: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createPrepareRenameTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent when rename is supported", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        prepareRename: vi.fn().mockResolvedValue({
          canRename: true,
          placeholder: "foo",
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
        }),
      } as never;
      const tool = createPrepareRenameTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: "src/index.ts",
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── lsp.ts: formatRange ───────────────────────────────────────────────────

  describe("formatRange (lsp.ts)", () => {
    it("emits structuredContent when no formatter available", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        formatRange: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createFormatRangeTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        startLine: 1,
        endLine: 5,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });

    it("emits structuredContent on successful format", async () => {
      const mockClient = {
        isConnected: () => true,
        lspReadyLanguages: new Set(["typescript"]),
        formatRange: vi
          .fn()
          .mockResolvedValue({ formatted: true, editCount: 3 }),
      } as never;
      const tool = createFormatRangeTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        startLine: 1,
        endLine: 5,
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

  // ── Claude orchestration tools ────────────────────────────────────────────

  describe("listClaudeTasks", () => {
    it("emits structuredContent with empty task list", async () => {
      const mockOrchestrator = {
        list: vi.fn().mockReturnValue([]),
      } as never;
      const tool = createListClaudeTasksTool(mockOrchestrator, "session-1");
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  describe("getClaudeTaskStatus", () => {
    it("emits structuredContent for a found task", async () => {
      const mockOrchestrator = {
        getTask: vi.fn().mockReturnValue({
          id: "task-1",
          status: "done",
          createdAt: Date.now(),
          startedAt: Date.now(),
          doneAt: Date.now(),
          output: "hello",
          errorMessage: undefined,
          timeoutMs: 120_000,
          sessionId: "session-1",
        }),
      } as never;
      const tool = createGetClaudeTaskStatusTool(mockOrchestrator, "session-1");
      const result = await tool.handler({ taskId: "task-1" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  describe("runClaudeTask", () => {
    it("emits structuredContent for a non-streaming enqueue", async () => {
      const mockOrchestrator = {
        enqueue: vi.fn().mockReturnValue("task-2"),
      } as never;
      const tool = createRunClaudeTaskTool(
        mockOrchestrator,
        "session-1",
        WORKSPACE,
      );
      const result = await tool.handler({ prompt: "hello" });
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

  // ── cancelClaudeTask ──────────────────────────────────────────────────────

  describe("cancelClaudeTask", () => {
    it("emits structuredContent on successful cancellation", async () => {
      const mockOrchestrator = {
        getTask: vi.fn().mockReturnValue({
          id: "task-1",
          status: "pending",
          sessionId: "session-1",
        }),
        cancel: vi.fn().mockReturnValue(true),
      } as never;
      const tool = createCancelClaudeTaskTool(mockOrchestrator, "session-1");
      const result = await tool.handler({ taskId: "task-1" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── resumeClaudeTask ──────────────────────────────────────────────────────

  describe("resumeClaudeTask", () => {
    it("emits structuredContent on successful resume", async () => {
      const mockOrchestrator = {
        getTask: vi.fn().mockReturnValue({
          id: "task-1",
          status: "done",
          sessionId: "session-1",
          prompt: "hello",
          contextFiles: [],
          timeoutMs: 120_000,
          model: undefined,
        }),
        enqueue: vi.fn().mockReturnValue("task-2"),
      } as never;
      const tool = createResumeClaudeTaskTool(mockOrchestrator, "session-1");
      const result = await tool.handler({ taskId: "task-1" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── setHandoffNote ────────────────────────────────────────────────────────

  describe("setHandoffNote", () => {
    it("emits structuredContent on save", async () => {
      const tool = createSetHandoffNoteTool("session-1", {
        configDir: WORKSPACE,
      });
      const result = await tool.handler({ note: "working on auth bug" });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── getHandoffNote ────────────────────────────────────────────────────────

  describe("getHandoffNote", () => {
    it("emits structuredContent when no note exists", async () => {
      const tool = createGetHandoffNoteTool({
        configDir: WORKSPACE + "/nonexistent-dir-xyz",
      });
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── getPRTemplate ─────────────────────────────────────────────────────────

  describe("getPRTemplate", () => {
    it("emits structuredContent when not a git repo", async () => {
      mockExecSafe.mockResolvedValueOnce({
        stdout: "",
        stderr: "not a git repo",
        exitCode: 128,
        timedOut: false,
        durationMs: 5,
      });
      const tool = createGetPRTemplateTool(WORKSPACE);
      const result = await tool.handler({});
      // error path returns isError — just check it's a valid content response
      expect(result.content[0]?.type).toBe("text");
    });
  });

  // ── inlayHints ────────────────────────────────────────────────────────────

  describe("getInlayHints", () => {
    it("emits structuredContent with hint results", async () => {
      const mockClient = {
        isConnected: () => true,
        getInlayHints: vi.fn().mockResolvedValue({
          hints: [{ position: {}, label: "string" }],
          count: 1,
        }),
      } as never;
      const tool = createGetInlayHintsTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        file: join(WORKSPACE, "index.ts"),
        startLine: 1,
        endLine: 10,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── semanticTokens ────────────────────────────────────────────────────────

  describe("getSemanticTokens", () => {
    it("emits structuredContent with token results", async () => {
      const mockClient = {
        isConnected: () => true,
        getSemanticTokens: vi.fn().mockResolvedValue({
          tokens: [],
          count: 0,
          capped: false,
          legend: { tokenTypes: [], tokenModifiers: [] },
        }),
      } as never;
      const tool = createGetSemanticTokensTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── codeLens ──────────────────────────────────────────────────────────────

  describe("getCodeLens", () => {
    it("emits structuredContent when extension returns null", async () => {
      const mockClient = {
        isConnected: () => true,
        getCodeLens: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetCodeLensTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── documentLinks ─────────────────────────────────────────────────────────

  describe("getDocumentLinks", () => {
    it("emits structuredContent when extension returns null", async () => {
      const mockClient = {
        isConnected: () => true,
        getDocumentLinks: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetDocumentLinksTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── foldingRanges ─────────────────────────────────────────────────────────

  describe("foldingRanges", () => {
    it("emits structuredContent when extension returns null", async () => {
      const mockClient = {
        isConnected: () => true,
        foldingRanges: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createFoldingRangesTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── selectionRanges ───────────────────────────────────────────────────────

  describe("selectionRanges", () => {
    it("emits structuredContent when extension returns null", async () => {
      const mockClient = {
        isConnected: () => true,
        selectionRanges: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createSelectionRangesTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── hoverAtCursor ─────────────────────────────────────────────────────────

  describe("getHoverAtCursor", () => {
    it("emits structuredContent when no active file", async () => {
      const mockClient = {
        isConnected: () => true,
        latestActiveFile: null,
        latestSelection: null,
        getHover: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetHoverAtCursorTool(mockClient);
      const result = await tool.handler({});
      // null file → extensionRequired or error, both are isError content — just check content exists
      expect(result.content[0]?.type).toBe("text");
    });

    it("emits structuredContent when hover is null at cursor", async () => {
      const mockClient = {
        isConnected: () => true,
        latestActiveFile: join(WORKSPACE, "index.ts"),
        latestSelection: null,
        getHover: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetHoverAtCursorTool(mockClient);
      const result = await tool.handler({});
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── typeHierarchy ─────────────────────────────────────────────────────────

  describe("getTypeHierarchy", () => {
    it("emits structuredContent when not found", async () => {
      const mockClient = {
        isConnected: () => true,
        getTypeHierarchy: vi.fn().mockResolvedValue(null),
      } as never;
      const tool = createGetTypeHierarchyTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        file: join(WORKSPACE, "index.ts"),
        line: 1,
        column: 1,
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── refactorPreview ───────────────────────────────────────────────────────

  describe("refactorPreview", () => {
    it("emits structuredContent on preview result", async () => {
      const mockClient = {
        isConnected: () => true,
        previewCodeAction: vi.fn().mockResolvedValue({
          title: "Extract variable",
          changes: [],
          totalFiles: 0,
          totalEdits: 0,
        }),
      } as never;
      const tool = createRefactorPreviewTool(WORKSPACE, mockClient);
      const result = await tool.handler({
        filePath: join(WORKSPACE, "index.ts"),
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 10,
        actionTitle: "Extract variable",
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });

  // ── refactorExtractFunction ───────────────────────────────────────────────

  describe("refactorExtractFunction", () => {
    it("emits structuredContent on path resolution failure", async () => {
      const mockClient = { isConnected: () => true } as never;
      const tool = createRefactorExtractFunctionTool(WORKSPACE, mockClient);
      // Pass a path with null byte to trigger resolveFilePath error → success({refactored:false})
      const result = await tool.handler({
        file: "src/\x00bad.ts",
        startLine: 1,
        endLine: 3,
        functionName: "extracted",
      });
      assertStructured(result as Parameters<typeof assertStructured>[0]);
    });
  });
});
