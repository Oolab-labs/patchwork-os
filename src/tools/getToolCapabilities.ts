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

      // Headless CLI fallbacks: several LSP-category tools still work without the
      // VS Code extension by shelling out to a language server / ctags probe.
      //   - typescript-language-server backs goToDefinition / findReferences /
      //     getTypeSignature
      //   - universal-ctags backs searchWorkspaceSymbols
      // When the extension is disconnected but a probe is present, report a
      // "headless-cli" degraded tier instead of "unavailable" / 0.
      const headlessLspTools: string[] = [
        ...(probes.typescriptLanguageServer
          ? ["goToDefinition", "findReferences", "getTypeSignature"]
          : []),
        ...(probes.universalCtags ? ["searchWorkspaceSymbols"] : []),
      ];
      const hasHeadlessLsp = headlessLspTools.length > 0;
      const lspFeature = connected
        ? "vscode"
        : hasHeadlessLsp
          ? "headless-cli"
          : "unavailable";

      const data = {
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
          lsp: lspFeature,
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
          // Connected tier only. The disconnected headless-cli tier is applied
          // as a post-construction override below so this inline array stays
          // cross-validated against SLIM_TOOL_NAMES (audit-lsp-tools.mjs).
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
          // 16 github* tools + 2 AI-comment tools, all gated behind the gh probe
          // (see the probes.gh block in src/tools/index.ts).
          ...(probes.gh ? { github: 18 } : {}),
          other: connected ? 23 : 10,
        },
      };

      // Headless-cli LSP tier override. When the extension is disconnected but a
      // language-server / ctags probe is present, the inline array above resolved
      // to [] / 0 (so it stays cross-validated against SLIM_TOOL_NAMES). Replace
      // it here with the fallback-capable tool names / count. verbose → name
      // array, otherwise the count; count === array length by construction.
      if (!connected && hasHeadlessLsp) {
        data.availableTools.lsp = verbose
          ? headlessLspTools
          : headlessLspTools.length;
      }

      return successStructured(data);
    },
  };
}
