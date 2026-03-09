import type { Config } from "../config.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import { success } from "./utils.js";

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
    },
    handler: async () => {
      return success({
        extensionConnected: extensionClient.isConnected(),
        editor: config.editorCommand ?? "none",
        cliTools: {
          rg: probes.rg,
          fd: probes.fd,
          git: probes.git,
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
            probes.tsc || probes.eslint || probes.pyright ||
            probes.ruff || probes.cargo || probes.go || probes.biome
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
            : "partial (lexical grep fallback for goToDefinition, findReferences, searchWorkspaceSymbols — hover, code actions, rename still require extension)",
          terminalOutput: extensionClient.isConnected()
            ? "available (output capture depends on VS Code proposed API)"
            : "unavailable (requires extension)",
        },
        commandAllowlist: config.commandAllowlist,
        availableTools: {
          // Always available (work with or without extension)
          files: [
            "openFile", "createFile", "deleteFile", "renameFile",
            "findFiles", "getFileTree", "getOpenEditors", "checkDocumentDirty",
            "saveDocument", "getBufferContent",
            ...(extensionClient.isConnected() ? ["watchFiles", "unwatchFiles"] : []),
          ],
          editing: [
            "replaceBlock", "editText", "openDiff", "closeAllDiffTabs",
            "formatDocument", "fixAllLintErrors",
            ...(extensionClient.isConnected() ? ["closeTab", "organizeImports"] : []),
          ],
          git: ["getGitStatus", "getGitDiff", "getGitLog", "gitAdd", "gitCommit", "gitCheckout", "gitBlame"],
          diagnostics: [
            "getDiagnostics", "diffDebug", "runTests",
            ...(extensionClient.isConnected() ? ["watchDiagnostics"] : []),
          ],
          search: ["searchWorkspace", "searchAndReplace"],
          lsp: extensionClient.isConnected()
            ? ["getDocumentSymbols", "goToDefinition", "findReferences", "getHover", "getCodeActions", "applyCodeAction", "renameSymbol", "searchWorkspaceSymbols"]
            : ["getDocumentSymbols (grep fallback)", "goToDefinition (grep fallback)", "findReferences (grep fallback)", "searchWorkspaceSymbols (grep fallback)"],
          planning: ["checkScope", "expandScope", "createPlan", "updatePlan", "getPlan", "deletePlan", "listPlans"],
          snapshots: ["createSnapshot", "listSnapshots", "restoreSnapshot", "deleteSnapshot", "showSnapshot"],
          terminal: extensionClient.isConnected()
            ? ["listTerminals", "getTerminalOutput", "createTerminal", "sendTerminalCommand"]
            : [],
          other: ["runCommand", "getToolCapabilities", "getProjectInfo", "getAIComments", "getActivityLog", "getCurrentSelection", "getLatestSelection", "getWorkspaceFolders"],
        },
      });
    },
  };
}
