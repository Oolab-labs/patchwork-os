import type { ActivityLog } from "../activityLog.js";
import type { AutomationHooks } from "../automation.js";
import type { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { Config } from "../config.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { FileLock } from "../fileLock.js";
import type { LoadedPluginTool } from "../pluginLoader.js";
import type { ProbeResults } from "../probe.js";
import type { McpTransport } from "../transport.js";
import {
  createGetActivityLogTool,
  createWatchActivityLogTool,
} from "./activityLog.js";
import { createAuditDependenciesTool } from "./auditDependencies.js";
import {
  createBatchFindImplementationsTool,
  createBatchGetHoverTool,
  createBatchGoToDefinitionTool,
} from "./batchLsp.js";
import { createBridgeDoctorTool } from "./bridgeDoctor.js";
import { createBridgeStatusTool, type DisconnectInfo } from "./bridgeStatus.js";
import { createCancelClaudeTaskTool } from "./cancelClaudeTask.js";
import { createCheckDocumentDirtyTool } from "./checkDocumentDirty.js";
import {
  createReadClipboardTool,
  createWriteClipboardTool,
} from "./clipboard.js";
import { createCloseAllDiffTabsTool, createCloseTabTool } from "./closeTabs.js";
import { createGetCodeLensTool } from "./codeLens.js";
import { createContextBundleTool } from "./contextBundle.js";
import { createCreateIssueFromAICommentTool } from "./createIssueFromAIComment.js";
import {
  createEvaluateInDebuggerTool,
  createSetDebugBreakpointsTool,
  createStartDebuggingTool,
  createStopDebuggingTool,
} from "./debug.js";
import {
  createClearEditorDecorationsTool,
  createSetEditorDecorationsTool,
} from "./decorations.js";
import { createDetectUnusedCodeTool } from "./detectUnusedCode.js";
import { createGetDocumentLinksTool } from "./documentLinks.js";
import { createEditTextTool } from "./editText.js";
import { createExplainSymbolTool } from "./explainSymbol.js";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createRenameFileTool,
} from "./fileOperations.js";
import { createUnwatchFilesTool, createWatchFilesTool } from "./fileWatcher.js";
import { createFindFilesTool } from "./findFiles.js";
import { createFindRelatedTestsTool } from "./findRelatedTests.js";
import { createFixAllLintErrorsTool } from "./fixAllLintErrors.js";
import { createFoldingRangesTool } from "./foldingRanges.js";
import { createFormatAndSaveTool } from "./formatAndSave.js";
import { createFormatDocumentTool } from "./formatDocument.js";
import { createGenerateAPIDocumentationTool } from "./generateAPIDocumentation.js";
import { createGenerateTestsTool } from "./generateTests.js";
import { createGetAICommentsTool } from "./getAIComments.js";
import { createGetAnalyticsReportTool } from "./getAnalyticsReport.js";
import { createGetArchitectureContextTool } from "./getArchitectureContext.js";
import { createGetBufferContentTool } from "./getBufferContent.js";
import { createGetChangeImpactTool } from "./getChangeImpact.js";
import { createGetClaudeTaskStatusTool } from "./getClaudeTaskStatus.js";
import { createGetCodeCoverageTool } from "./getCodeCoverage.js";
import {
  createGetCurrentSelectionTool,
  createGetLatestSelectionTool,
} from "./getCurrentSelection.js";
import { createGetDebugStateTool } from "./getDebugState.js";
import { createGetDependencyTreeTool } from "./getDependencyTree.js";
import { createGetDiagnosticsTool } from "./getDiagnostics.js";
import { createGetDocumentSymbolsTool } from "./getDocumentSymbols.js";
import { createGetFileTreeTool } from "./getFileTree.js";
import { createGetGitDiffTool } from "./getGitDiff.js";
import { createGetGitHotspotsTool } from "./getGitHotspots.js";
import { createGetGitLogTool } from "./getGitLog.js";
import { createGetGitStatusTool } from "./getGitStatus.js";
import { createGetImportedSignaturesTool } from "./getImportedSignatures.js";
import { createGetImportTreeTool } from "./getImportTree.js";
import { createGetOpenEditorsTool } from "./getOpenEditors.js";
import { createGetPRTemplateTool } from "./getPRTemplate.js";
import { createGetProjectContextTool } from "./getProjectContext.js";
import { createGetProjectInfoTool } from "./getProjectInfo.js";
import { createGetSecurityAdvisoriesTool } from "./getSecurityAdvisories.js";
import { createGetSessionUsageTool } from "./getSessionUsage.js";
import { createGetSymbolHistoryTool } from "./getSymbolHistory.js";
import { createGetToolCapabilitiesTool } from "./getToolCapabilities.js";
import { createGetTypeSignatureTool } from "./getTypeSignature.js";
import { createGetWorkspaceFoldersTool } from "./getWorkspaceFolders.js";
import { createGetWorkspaceSettingsTool } from "./getWorkspaceSettings.js";
import {
  createGetCommitDetailsTool,
  createGetDiffBetweenRefsTool,
} from "./gitHistory.js";
import {
  createGithubCommentIssueTool,
  createGithubCreateIssueTool,
  createGithubCreatePRTool,
  createGithubGetIssueTool,
  createGithubGetPRDiffTool,
  createGithubGetRunLogsTool,
  createGithubListIssuesTool,
  createGithubListPRsTool,
  createGithubListRunsTool,
  createGithubPostPRReviewTool,
  createGithubViewPRTool,
} from "./github/index.js";
import {
  createGitAddTool,
  createGitBlameTool,
  createGitCheckoutTool,
  createGitCommitTool,
  createGitFetchTool,
  createGitListBranchesTool,
  createGitPullTool,
  createGitPushTool,
  createGitStashListTool,
  createGitStashPopTool,
  createGitStashTool,
} from "./gitWrite.js";
import {
  createGetHandoffNoteTool,
  createSetHandoffNoteTool,
} from "./handoffNote.js";
import { createGetHoverAtCursorTool } from "./hoverAtCursor.js";
import {
  createParseHttpFileTool,
  createSendHttpRequestTool,
} from "./httpClient.js";
import { createGetInlayHintsTool } from "./inlayHints.js";
import { createJumpToFirstErrorTool } from "./jumpToFirstError.js";
import { createListClaudeTasksTool } from "./listClaudeTasks.js";
import { createListTerminalsTool } from "./listTerminals.js";
import {
  createApplyCodeActionTool,
  createFindImplementationsTool,
  createFindReferencesTool,
  createFormatRangeTool,
  createGetCallHierarchyTool,
  createGetCodeActionsTool,
  createGetHoverTool,
  createGoToDeclarationTool,
  createGoToDefinitionTool,
  createGoToTypeDefinitionTool,
  createPrepareRenameTool,
  createPreviewCodeActionTool,
  createRenameSymbolTool,
  createSearchWorkspaceSymbolsTool,
} from "./lsp.js";
import { createNavigateToSymbolByNameTool } from "./navigateToSymbolByName.js";
import { createOpenDiffTool } from "./openDiff.js";
import { createOpenFileTool } from "./openFile.js";
import { createOpenInBrowserTool } from "./openInBrowser.js";
import { createOrganizeImportsTool } from "./organizeImports.js";
import { createPlanTools } from "./planPersistence.js";
import { createRefactorAnalyzeTool } from "./refactorAnalyze.js";
import { createRefactorExtractFunctionTool } from "./refactorExtractFunction.js";
import { createRefactorPreviewTool } from "./refactorPreview.js";
import { createReplaceBlockTool } from "./replaceBlock.js";
import { createResumeClaudeTaskTool } from "./resumeClaudeTask.js";
import { createRunClaudeTaskTool } from "./runClaudeTask.js";
import { createRunCommandTool } from "./runCommand.js";
import { createRunTestsTool } from "./runTests.js";
import { createSaveDocumentTool } from "./saveDocument.js";
import { createCaptureScreenshotTool } from "./screenshot.js";
import { createScreenshotAndAnnotateTool } from "./screenshotAndAnnotate.js";
import { createSearchAndReplaceTool } from "./searchAndReplace.js";
import { createSearchWorkspaceTool } from "./searchWorkspace.js";
import { createSelectionRangesTool } from "./selectionRanges.js";
import { createGetSemanticTokensTool } from "./semanticTokens.js";
import { createSetActiveWorkspaceFolderTool } from "./setActiveWorkspaceFolder.js";
import { createSignatureHelpTool } from "./signatureHelp.js";
import {
  createCreateTerminalTool,
  createDisposeTerminalTool,
  createGetTerminalOutputTool,
  createRunInTerminalTool,
  createSendTerminalCommandTool,
  createWaitForTerminalOutputTool,
} from "./terminal.js";
import { createGetTypeHierarchyTool } from "./typeHierarchy.js";
import {
  createExecuteVSCodeCommandTool,
  createListVSCodeCommandsTool,
} from "./vscodeCommands.js";
import {
  createListVSCodeTasksTool,
  createRunVSCodeTaskTool,
} from "./vscodeTasks.js";
import { createWatchDiagnosticsTool } from "./watchDiagnostics.js";
import { createSetWorkspaceSettingTool } from "./workspaceSettings.js";

/**
 * The 53 IDE-exclusive tools registered in slim mode (the default).
 *
 * Slim mode exposes only tools that require a live IDE extension — tools that
 * Claude cannot replicate via its native Read/Write/Bash capabilities. Everything
 * else (git, terminal, file ops, HTTP, GitHub) is available in full mode (--full).
 *
 * To move a tool between modes: add or remove its name from this set.
 */
export const SLIM_TOOL_NAMES = new Set<string>([
  // Editor state
  "getOpenEditors",
  "getCurrentSelection",
  "getLatestSelection",
  "checkDocumentDirty",
  "saveDocument",
  "openFile",
  "closeTab",
  "captureScreenshot",
  "watchActivityLog",
  "contextBundle",
  "getProjectContext",
  "getAnalyticsReport",
  // LSP / code intelligence
  "getDiagnostics",
  "watchDiagnostics",
  "getDocumentSymbols",
  "goToDefinition",
  "findReferences",
  "findImplementations",
  "goToTypeDefinition",
  "goToDeclaration",
  "getHover",
  "getCodeActions",
  "applyCodeAction",
  "previewCodeAction",
  "refactorPreview",
  "renameSymbol",
  "searchWorkspaceSymbols",
  "getCallHierarchy",
  "explainSymbol",
  "prepareRename",
  "signatureHelp",
  "refactorAnalyze",
  "selectionRanges",
  "foldingRanges",
  "refactorExtractFunction",
  "getImportTree",
  "getImportedSignatures",
  "getDocumentLinks",
  "batchGetHover",
  "batchGoToDefinition",
  "batchFindImplementations",
  "getSemanticTokens",
  "getCodeLens",
  "getChangeImpact",
  "getTypeHierarchy",
  "getInlayHints",
  "getHoverAtCursor",
  // Editor decorations — needed for code review workflows
  "setEditorDecorations",
  "clearEditorDecorations",
  // Debugger
  "getDebugState",
  "evaluateInDebugger",
  "setDebugBreakpoints",
  "startDebugging",
  "stopDebugging",
  // VS Code escape hatch
  "executeVSCodeCommand",
  // Bridge introspection — Claude needs these to understand bridge state and discover --full
  "getBridgeStatus",
  "getToolCapabilities",
  "bridgeDoctor",
  "getSessionUsage",
]);

/**
 * Context object for all tool factories.
 *
 * Currently tools receive individual parameters via registerAllTools — this
 * interface documents the full context surface and serves as the migration
 * path toward a single `ctx: ToolContext` parameter in a future refactor.
 */
export interface ToolContext {
  transport: McpTransport;
  config: Config;
  openedFiles: Set<string>;
  probes: ProbeResults;
  extensionClient: ExtensionClient;
  activityLog?: ActivityLog;
  terminalPrefix?: string;
  fileLock?: FileLock;
  sessions?: Map<string, unknown>;
  orchestrator?: ClaudeOrchestrator | null;
  sessionId?: string;
  pluginTools?: LoadedPluginTool[];
}

export function registerAllTools(
  transport: McpTransport,
  config: Config,
  openedFiles: Set<string>,
  probes: ProbeResults,
  extensionClient: ExtensionClient,
  activityLog?: ActivityLog,
  terminalPrefix = "",
  fileLock?: FileLock,
  sessions?: Map<string, unknown>,
  orchestrator: ClaudeOrchestrator | null = null,
  sessionId = "",
  pluginTools: LoadedPluginTool[] = [],
  automationHooks: AutomationHooks | null = null,
  getDisconnectInfo?: () => DisconnectInfo,
): void {
  const workspace = config.workspace;
  const workspaceFolders = config.workspaceFolders;

  const diagnosticsTool = createGetDiagnosticsTool(
    workspace,
    probes,
    extensionClient,
    config.linters.length > 0 ? config.linters : undefined,
  );

  const testsTool = createRunTestsTool(
    workspace,
    probes,
    automationHooks ? (r) => automationHooks.handleTestRun(r) : undefined,
  );

  // Dep-injected tools for composite factories.
  // Extract before `tools = [...]` so composite tools can receive them.
  const formatDocumentTool = createFormatDocumentTool(
    workspace,
    probes,
    extensionClient,
  );
  const saveDocumentTool = createSaveDocumentTool(workspace, extensionClient);
  const openFileTool = createOpenFileTool(
    workspace,
    config.editorCommand,
    openedFiles,
    extensionClient,
  );
  const setEditorDecorationsToolInstance = createSetEditorDecorationsTool(
    workspace,
    extensionClient,
  );

  const tools = [
    openFileTool,
    createOpenDiffTool(workspace, config.editorCommand),
    createOpenInBrowserTool(),
    createGetOpenEditorsTool(openedFiles, extensionClient, workspace),
    createGetWorkspaceFoldersTool(workspaceFolders, extensionClient),
    createGetArchitectureContextTool(workspace),
    createGetProjectInfoTool(workspace),
    createGetCurrentSelectionTool(extensionClient),
    createGetLatestSelectionTool(extensionClient),
    diagnosticsTool,
    createCheckDocumentDirtyTool(workspace, extensionClient),
    saveDocumentTool,
    createCloseTabTool(workspace, extensionClient),
    createCloseAllDiffTabsTool(),
    createGetToolCapabilitiesTool(probes, extensionClient, config),
    createBridgeDoctorTool(
      workspace,
      extensionClient,
      probes,
      config.port ?? 0,
    ),
    createSearchWorkspaceTool(workspace, probes),
    createSearchAndReplaceTool(workspace),
    createFindFilesTool(workspace, probes),
    createGetFileTreeTool(workspace, probes),
    createGetGitStatusTool(workspace),
    createGetGitDiffTool(workspace),
    createGetGitLogTool(workspace),
    createGetCommitDetailsTool(workspace),
    createGetDiffBetweenRefsTool(workspace),
    createGitAddTool(workspace),
    createGitCommitTool(
      workspace,
      automationHooks ? (r) => automationHooks.handleGitCommit(r) : undefined,
    ),
    createGitCheckoutTool(
      workspace,
      automationHooks
        ? (r) => automationHooks.handleBranchCheckout(r)
        : undefined,
    ),
    createGitBlameTool(workspace),
    createGitFetchTool(workspace),
    createGitListBranchesTool(workspace),
    createGitPullTool(
      workspace,
      automationHooks ? (r) => automationHooks.handleGitPull(r) : undefined,
    ),
    createGitPushTool(
      workspace,
      automationHooks ? (r) => automationHooks.handleGitPush(r) : undefined,
    ),
    createGitStashTool(workspace),
    createGitStashPopTool(workspace),
    createGitStashListTool(workspace),
    createRunCommandTool(workspace, config),
    createGetDocumentSymbolsTool(workspace, extensionClient),
    createGoToDefinitionTool(
      workspace,
      extensionClient,
      probes.typescriptLanguageServer,
    ),
    createFindReferencesTool(
      workspace,
      extensionClient,
      probes.typescriptLanguageServer,
    ),
    createFindImplementationsTool(workspace, extensionClient),
    createGoToTypeDefinitionTool(workspace, extensionClient),
    createGoToDeclarationTool(workspace, extensionClient),
    createGetHoverTool(workspace, extensionClient),
    createGetCodeActionsTool(workspace, extensionClient),
    createApplyCodeActionTool(workspace, extensionClient),
    createPreviewCodeActionTool(workspace, extensionClient),
    createRefactorPreviewTool(workspace, extensionClient),
    createRenameSymbolTool(workspace, extensionClient),
    createSearchWorkspaceSymbolsTool(
      workspace,
      extensionClient,
      probes.universalCtags,
    ),
    createGetCallHierarchyTool(workspace, extensionClient),
    createExplainSymbolTool(workspace, extensionClient),
    createPrepareRenameTool(workspace, extensionClient),
    createFormatRangeTool(workspace, extensionClient),
    createSignatureHelpTool(workspace, extensionClient),
    createRefactorAnalyzeTool(workspace, extensionClient),
    createFoldingRangesTool(workspace, extensionClient),
    createSelectionRangesTool(workspace, extensionClient),
    createContextBundleTool(workspace, extensionClient),
    // The Chosen Five
    ...createPlanTools(workspace),
    testsTool,
    ...(activityLog
      ? [
          createGetActivityLogTool(activityLog),
          createWatchActivityLogTool(activityLog),
        ]
      : []),
    createBridgeStatusTool(
      extensionClient,
      probes,
      sessions,
      orchestrator,
      automationHooks,
      getDisconnectInfo,
    ),
    createWatchFilesTool(extensionClient),
    createUnwatchFilesTool(extensionClient),
    createListTerminalsTool(extensionClient, terminalPrefix),
    createGetTerminalOutputTool(extensionClient, terminalPrefix),
    createCreateTerminalTool(workspace, extensionClient, terminalPrefix),
    createDisposeTerminalTool(extensionClient, terminalPrefix),
    createSendTerminalCommandTool(
      extensionClient,
      config.commandAllowlist,
      terminalPrefix,
    ),
    createRunInTerminalTool(
      workspace,
      extensionClient,
      config.commandAllowlist,
      terminalPrefix,
    ),
    createWaitForTerminalOutputTool(extensionClient, terminalPrefix),
    createCreateFileTool(workspace, extensionClient),
    createDeleteFileTool(workspace, extensionClient),
    createRenameFileTool(workspace, extensionClient),
    createGetBufferContentTool(workspace, extensionClient),
    createReplaceBlockTool(workspace, extensionClient, fileLock, sessionId),
    createEditTextTool(workspace, extensionClient, fileLock, sessionId),
    formatDocumentTool,
    createFormatAndSaveTool({
      formatDocument: formatDocumentTool,
      saveDocument: saveDocumentTool,
    }),
    createJumpToFirstErrorTool({
      getDiagnostics: diagnosticsTool,
      openFile: openFileTool,
      setEditorDecorations: setEditorDecorationsToolInstance,
      extensionClient,
    }),
    createNavigateToSymbolByNameTool(extensionClient, workspace, probes.rg),
    createFixAllLintErrorsTool(workspace, probes, extensionClient),
    createOrganizeImportsTool(workspace, extensionClient),
    createWatchDiagnosticsTool(
      workspace,
      extensionClient,
      probes,
      config.linters.length > 0 ? config.linters : undefined,
    ),
    // Phase 4: Additional features
    createReadClipboardTool(extensionClient),
    createWriteClipboardTool(extensionClient),
    createGetHandoffNoteTool({ workspace: config.workspace }),
    createSetHandoffNoteTool(sessionId, { workspace: config.workspace }),
    createGetWorkspaceSettingsTool(extensionClient),
    createSetWorkspaceSettingTool(extensionClient),
    createCaptureScreenshotTool(extensionClient),
    createExecuteVSCodeCommandTool(extensionClient, config),
    createListVSCodeCommandsTool(extensionClient),
    createListVSCodeTasksTool(extensionClient),
    createRunVSCodeTaskTool(extensionClient),
    createGetInlayHintsTool(workspace, extensionClient),
    createGetHoverAtCursorTool(extensionClient),
    createGetTypeSignatureTool(
      extensionClient,
      workspace,
      probes.typescriptLanguageServer,
    ),
    createGetImportTreeTool(workspace),
    createGetImportedSignaturesTool(workspace, extensionClient),
    createGetDocumentLinksTool(workspace, extensionClient),
    createBatchGetHoverTool(workspace, extensionClient),
    createBatchGoToDefinitionTool(workspace, extensionClient),
    createBatchFindImplementationsTool(workspace, extensionClient),
    createGetTypeHierarchyTool(workspace, extensionClient),
    createGetSemanticTokensTool(workspace, extensionClient),
    createGetCodeLensTool(workspace, extensionClient),
    createGetChangeImpactTool(workspace, extensionClient),
    createGetDebugStateTool(extensionClient),
    createEvaluateInDebuggerTool(extensionClient),
    createSetDebugBreakpointsTool(workspace, extensionClient),
    createStartDebuggingTool(extensionClient),
    createStopDebuggingTool(extensionClient),
    setEditorDecorationsToolInstance,
    createClearEditorDecorationsTool(extensionClient),
    createSetActiveWorkspaceFolderTool(config),
    createSendHttpRequestTool({
      allowPrivateHttp: config.allowPrivateHttp,
    }),
    createParseHttpFileTool(workspace),
    // Dependency & security tools
    createGetDependencyTreeTool(workspace, probes),
    createGetSecurityAdvisoriesTool(workspace, probes),
    createAuditDependenciesTool(workspace, probes),
    createDetectUnusedCodeTool(workspace, probes),
    createGenerateAPIDocumentationTool(workspace),
    createRefactorExtractFunctionTool(workspace, extensionClient),
    createGetGitHotspotsTool(workspace),
    createGetSymbolHistoryTool(workspace, extensionClient),
    createGetProjectContextTool(workspace, extensionClient, probes),
    createGetSessionUsageTool(transport),
    ...(activityLog !== undefined
      ? [createGetAnalyticsReportTool(activityLog, orchestrator ?? null)]
      : []),
    createFindRelatedTestsTool(workspace, probes),
    createScreenshotAndAnnotateTool(workspace, extensionClient),
    createGetPRTemplateTool(workspace),
    createGetCodeCoverageTool(workspace),
    createGenerateTestsTool(workspace),
    ...(probes.gh
      ? [
          createGithubCreatePRTool(
            workspace,
            automationHooks
              ? (r) => automationHooks.handlePullRequest(r)
              : undefined,
          ),
          createGithubListPRsTool(workspace),
          createGithubViewPRTool(workspace),
          createGithubListIssuesTool(workspace),
          createGithubGetIssueTool(workspace),
          createGithubCreateIssueTool(workspace),
          createGithubCommentIssueTool(workspace),
          createGithubListRunsTool(workspace, config.githubDefaultRepo),
          createGithubGetRunLogsTool(workspace, config.githubDefaultRepo),
          createGithubGetPRDiffTool(workspace),
          createGithubPostPRReviewTool(workspace),
          createGetAICommentsTool(extensionClient),
          createCreateIssueFromAICommentTool(
            workspace,
            extensionClient.latestAIComments,
          ),
        ]
      : []),
    ...(orchestrator !== null
      ? [
          createRunClaudeTaskTool(orchestrator, sessionId, workspace),
          createGetClaudeTaskStatusTool(orchestrator, sessionId),
          createCancelClaudeTaskTool(orchestrator, sessionId),
          createListClaudeTasksTool(orchestrator, sessionId),
          createResumeClaudeTaskTool(orchestrator, sessionId),
        ]
      : []),
  ];

  const activeTools = config.fullMode
    ? tools
    : tools.filter((t) => SLIM_TOOL_NAMES.has(t.schema.name));

  // Plugin tools always bypass the slim filter — they are opt-in by definition.
  for (const tool of [...activeTools, ...pluginTools]) {
    transport.registerTool(tool.schema, tool.handler);
  }
}
