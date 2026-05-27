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
        "Available CLI tools, ext connection state, and which features are functional vs stub-only.",
      annotations: { readOnlyHint: true },
      cache_control: { type: "ephemeral" as const },
      inputSchema: {
        type: "object" as const,
        properties: {
          verbose: {
            type: "boolean",
            description:
              "When true, expand lsp category to a name array instead of a count.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          extensionConnected: { type: "boolean" },
          tier: { type: "string" },
          editor: { type: "string" },
          cliTools: { type: "object" },
          linters: { type: "object" },
          formatters: { type: "object" },
          testRunners: { type: "object" },
          features: { type: "object" },
          commandAllowlist: { type: "array", items: { type: "string" } },
          availableTools: {
            type: "object",
            description:
              "Per-category tool counts (integer). lsp is a name array only when verbose:true.",
          },
        },
        required: [
          "extensionConnected",
          "tier",
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
    handler: async (params: { verbose?: boolean } = {}) => {
      const connected = extensionClient.isConnected();
      const verbose = params.verbose === true;
      return successStructured({
        extensionConnected: connected,
        tier: connected ? "full" : "basic",
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
            connected ||
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
          fileOps: connected ? "vscode" : "native",
          editText: connected ? "vscode" : "native",
          selection: connected ? "available" : "stub-only",
          dirtyCheck: connected ? "real-time" : "mtime-heuristic",
          save: connected
            ? "vscode"
            : config.editorCommand
              ? "editor-cli"
              : "no-op",
          lsp: connected ? "vscode" : "unavailable",
          terminalOutput: connected ? "available" : "unavailable",
        },
        commandAllowlist: config.commandAllowlist,
        availableTools: {
          // Integer counts per category. lsp is kept as a name array for
          // cross-validation against SLIM_TOOL_NAMES in tests.
          files: connected ? 12 : 10,
          editing: connected ? 8 : 6,
          git: 16,
          diagnostics: connected ? 3 : 2,
          search: 2,
          lsp: verbose
            ? connected
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
                  "batchFindImplementations",
                  "refactorExtractFunction",
                  "getImportTree",
                  "findImplementations",
                  "goToTypeDefinition",
                  "goToDeclaration",
                ]
              : []
            : connected
              ? 33
              : 0,
          planning: 5,
          terminal: connected ? 7 : 0,
          debug: connected ? 5 : 0,
          http: 2,
          analysis: 8 + (probes.gh ? 1 : 0),
          ...(probes.gh ? { github: 11 } : {}),
          other: connected ? 23 : 10,
        },
      });
    },
  };
}
