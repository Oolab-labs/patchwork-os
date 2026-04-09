import type { Config } from "../config.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import { successStructured } from "./utils.js";

export function createGetToolCapabilitiesTool(
  probes: ProbeResults,
  extensionClient: ExtensionClient,
  config: Config,
) {
  return {
    schema: {
      name: "getToolCapabilities",
      description:
        "Returns the actual capabilities of this IDE bridge — which CLI tools are available, whether the VS Code extension is connected, and which features are functional vs stub-only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          extensionConnected: { type: "boolean" },
          tier: { type: "string" },
          tierDescription: { type: "string" },
          editor: { type: "string" },
          cliTools: { type: "object" },
          linters: { type: "object" },
          formatters: { type: "object" },
          testRunners: { type: "object" },
          features: { type: "object" },
          commandAllowlist: { type: "array", items: { type: "string" } },
          availableTools: { type: "object" },
        },
        required: [
          "extensionConnected",
          "tier",
          "tierDescription",
          "cliTools",
          "linters",
          "formatters",
          "testRunners",
          "features",
          "commandAllowlist",
          "availableTools",
        ],
      },
    },
    handler: async () => {
      return successStructured({
        extensionConnected: extensionClient.isConnected(),
        tier: extensionClient.isConnected() ? "full" : "basic",
        tierDescription: extensionClient.isConnected()
          ? "All tools available including LSP, debugger, and terminal integration"
          : "File operations, Git, GitHub, and CLI tools available. Connect the VS Code extension for LSP, debugger, and terminal tools.",
        editor: config.editorCommand ?? "none",
        cliTools: {
          rg: probes.rg,
          fd: probes.fd,
          git: probes.git,
          codex: probes.codex,
        },
        linters: {
          tsc: probes.tsc,
          eslint: probes.eslint,
          pyright: probes.pyright,
          ruff: probes.ruff,
          cargo: probes.cargo,
          go: probes.go,
          biome: probes.biome,
        },
        formatters: {
          prettier: probes.prettier,
          black: probes.black,
          gofmt: probes.gofmt,
          rustfmt: probes.rustfmt,
        },
        testRunners: {
          vitest: probes.vitest,
          jest: probes.jest,
          pytest: probes.pytest,
          cargo: probes.cargo,
          go: probes.go,
        },
        features: {
          diagnostics:
            extensionClient.isConnected() ||
            probes.tsc ||
            probes.eslint ||
            probes.pyright ||
            probes.ruff ||
            probes.cargo ||
            probes.go ||
            probes.biome
              ? "available"
              : "unavailable",
          search: probes.rg ? "rg" : "grep-fallback",
          fileSearch: probes.fd
            ? "fd"
            : probes.git
              ? "git-ls-files"
              : "find-fallback",
          fileOps: extensionClient.isConnected()
            ? "available (VS Code)"
            : "available (native fs fallback — no trash, no undo buffer)",
          editText: extensionClient.isConnected()
            ? "available (VS Code WorkspaceEdit)"
            : "available (native fs fallback — no undo buffer)",
          selection: extensionClient.isConnected() ? "available" : "stub-only",
          dirtyCheck: extensionClient.isConnected()
            ? "real-time"
            : "mtime-heuristic",
          save: extensionClient.isConnected()
            ? "real-buffer-save (VS Code)"
            : config.editorCommand
              ? "editor-cli-reopen (edits already on disk)"
              : "no-op (edits already on disk via editText)",
          lsp: extensionClient.isConnected()
            ? "available (VS Code LSP)"
            : "unavailable (requires extension)",
          terminalOutput: extensionClient.isConnected()
            ? "available (runInTerminal uses VS Code shell integration; getTerminalOutput uses proposed API)"
            : "unavailable (requires extension)",
        },
        commandAllowlist: config.commandAllowlist,
        availableTools: {
          // Always available (work with or without extension)
          files: [
            "openFile",
            "createFile",
            "deleteFile",
            "renameFile",
            "findFiles",
            "getFileTree",
            "getOpenEditors",
            "checkDocumentDirty",
            "saveDocument",
            "getBufferContent",
            ...(extensionClient.isConnected()
              ? ["watchFiles", "unwatchFiles"]
              : []),
          ],
          editing: [
            "replaceBlock",
            "editText",
            "openDiff",
            "closeAllDiffTabs",
            "formatDocument",
            "fixAllLintErrors",
            ...(extensionClient.isConnected()
              ? ["closeTab", "organizeImports"]
              : []),
          ],
          git: [
            "getGitStatus",
            "getGitDiff",
            "getGitLog",
            "gitAdd",
            "gitCommit",
            "gitCheckout",
            "gitBlame",
            "gitFetch",
            "gitPull",
            "gitPush",
            "gitListBranches",
            "gitStash",
            "gitStashPop",
            "gitStashList",
            "getCommitDetails",
            "getDiffBetweenRefs",
          ],
          diagnostics: [
            "getDiagnostics",
            "runTests",
            ...(extensionClient.isConnected() ? ["watchDiagnostics"] : []),
          ],
          search: ["searchWorkspace", "searchAndReplace"],
          lsp: extensionClient.isConnected()
            ? [
                "getDocumentSymbols",
                "goToDefinition",
                "findReferences",
                "getHover",
                "getCodeActions",
                "applyCodeAction",
                "previewCodeAction",
                "renameSymbol",
                "searchWorkspaceSymbols",
                "getCallHierarchy",
                "getTypeHierarchy",
                "getInlayHints",
                "getHoverAtCursor",
                "explainSymbol",
                "refactorPreview",
                "prepareRename",
                "signatureHelp",
                "foldingRanges",
                "selectionRanges",
                "refactorAnalyze",
                "getSemanticTokens",
                "getCodeLens",
                "getChangeImpact",
                "getImportedSignatures",
                "getDocumentLinks",
                "batchGetHover",
                "batchGoToDefinition",
                "refactorExtractFunction",
                "getImportTree",
                "findImplementations",
                "goToTypeDefinition",
                "goToDeclaration",
              ]
            : [],
          planning: [
            "createPlan",
            "updatePlan",
            "getPlan",
            "deletePlan",
            "listPlans",
          ],
          terminal: extensionClient.isConnected()
            ? [
                "listTerminals",
                "getTerminalOutput",
                "createTerminal",
                "sendTerminalCommand",
                "runInTerminal",
                "waitForTerminalOutput",
                "disposeTerminal",
              ]
            : [],
          debug: extensionClient.isConnected()
            ? [
                "getDebugState",
                "evaluateInDebugger",
                "setDebugBreakpoints",
                "startDebugging",
                "stopDebugging",
              ]
            : [],
          http: ["sendHttpRequest", "parseHttpFile"],
          analysis: [
            "getTypeSignature",
            "getImportTree",
            "getCodeCoverage",
            "generateTests",
            "getDependencyTree",
            "getGitHotspots",
            "getSecurityAdvisories",
            "getPRTemplate",
            ...(probes.gh ? ["createIssueFromAIComment"] : []),
          ],
          ...(probes.gh
            ? {
                github: [
                  "githubCreatePR",
                  "githubListPRs",
                  "githubViewPR",
                  "githubGetPRDiff",
                  "githubPostPRReview",
                  "githubListIssues",
                  "githubGetIssue",
                  "githubCreateIssue",
                  "githubCommentIssue",
                  "githubListRuns",
                  "githubGetRunLogs",
                ],
              }
            : {}),
          other: [
            "runCommand",
            "getToolCapabilities",
            "getProjectInfo",
            "getAIComments",
            "getActivityLog",
            "getCurrentSelection",
            "getLatestSelection",
            "getWorkspaceFolders",
            "setActiveWorkspaceFolder",
            "bridgeStatus",
            ...(extensionClient.isConnected()
              ? [
                  "readClipboard",
                  "writeClipboard",
                  "getWorkspaceSettings",
                  "setWorkspaceSetting",
                  "executeVSCodeCommand",
                  "listVSCodeCommands",
                  "getNotebookCells",
                  "runNotebookCell",
                  "getNotebookOutput",
                  "setEditorDecorations",
                  "clearEditorDecorations",
                  "listTasks",
                  "runTask",
                ]
              : []),
          ],
        },
      });
    },
  };
}
