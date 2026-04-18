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
import { createCtxGetTaskContextTool } from "./ctxGetTaskContext.js";
import { createCtxQueryTracesTool } from "./ctxQueryTraces.js";
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
import { createEnrichCommitTool } from "./enrichCommit.js";
import { createEnrichStackTraceTool } from "./enrichStackTrace.js";
import { createExplainDiagnosticTool } from "./explainDiagnostic.js";
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
import { createGetCommitsForIssueTool } from "./getCommitsForIssue.js";
import {
  createGetCurrentSelectionTool,
  createGetLatestSelectionTool,
} from "./getCurrentSelection.js";
import { createGetDebugStateTool } from "./getDebugState.js";
import { createGetDependencyTreeTool } from "./getDependencyTree.js";
import { createGetDiagnosticsTool } from "./getDiagnostics.js";
import { createGetDiffFromHandoffTool } from "./getDiffFromHandoff.js";
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
import { createLaunchQuickTaskTool } from "./launchQuickTask.js";
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
import { createGetPerformanceReportTool } from "./performanceReport.js";
import { createPlanTools } from "./planPersistence.js";
import { createPreviewEditTool } from "./previewEdit.js";
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
import { createSearchToolsTool } from "./searchTools.js";
import { createSearchWorkspaceTool } from "./searchWorkspace.js";
import { createSelectionRangesTool } from "./selectionRanges.js";
import { createGetSemanticTokensTool } from "./semanticTokens.js";
import { createSetActiveWorkspaceFolderTool } from "./setActiveWorkspaceFolder.js";
import { createSignatureHelpTool } from "./signatureHelp.js";
import { createSpawnWorkspaceTool } from "./spawnWorkspace.js";
import {
  createCreateTerminalTool,
  createDisposeTerminalTool,
  createGetTerminalOutputTool,
  createRunInTerminalTool,
  createSendTerminalCommandTool,
  createWaitForTerminalOutputTool,
} from "./terminal.js";
import { createTestTraceToSourceTool } from "./testTraceToSource.js";
import { createTransactionTools } from "./transaction.js";
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
 * The IDE-exclusive tools registered in slim mode (opt-in via `--slim`).
 *
 * Full mode is the default (enabled since v2.43.0). Slim mode exposes only
 * tools that require a live IDE extension — tools Claude cannot replicate via
 * its native Read/Write/Bash capabilities. Everything else (git, terminal,
 * file ops, HTTP, GitHub) is available in full mode.
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
  "getPerformanceReport",
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
  "searchTools",
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
  automationHooks: AutomationHooks | undefined = undefined,
  getDisconnectInfo?: () => DisconnectInfo,
  onContextCacheUpdated?: (generatedAt: string) => void,
  getExtensionDisconnectCount?: () => number,
  commitIssueLinkLog?: import("../commitIssueLinkLog.js").CommitIssueLinkLog,
  recipeRunLog?: import("../runLog.js").RecipeRunLog,
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
  const getHandoffNoteToolInstance = createGetHandoffNoteTool({
    workspace: config.workspace,
  });
  const getProjectContextToolInstance = createGetProjectContextTool(
    workspace,
    extensionClient,
    probes,
    { onCacheUpdated: onContextCacheUpdated },
  );
  const getAnalyticsReportToolInstance =
    activityLog !== undefined
      ? createGetAnalyticsReportTool(activityLog, orchestrator ?? null)
      : null;
  const getPerformanceReportToolInstance =
    activityLog !== undefined
      ? createGetPerformanceReportTool({
          activityLog,
          extensionClient,
          getSessions: () => {
            let inGrace = 0;
            if (sessions) {
              for (const s of (
                sessions as Map<string, { graceTimer: unknown }>
              ).values()) {
                if (s.graceTimer) inGrace++;
              }
            }
            return { active: sessions?.size ?? 0, inGrace };
          },
          getRateLimitRejected: () => activityLog.getRateLimitRejections(),
          getExtensionDisconnectCount: getExtensionDisconnectCount ?? (() => 0),
        })
      : null;
  const runClaudeTaskToolInstance =
    orchestrator !== null
      ? createRunClaudeTaskTool(orchestrator, sessionId, workspace)
      : null;
  const resumeClaudeTaskToolInstance =
    orchestrator !== null
      ? createResumeClaudeTaskTool(orchestrator, sessionId)
      : null;
  const launchQuickTaskToolInstance =
    runClaudeTaskToolInstance !== null && resumeClaudeTaskToolInstance !== null
      ? createLaunchQuickTaskTool({
          runTask: (a) => runClaudeTaskToolInstance.handler(a),
          resumeTask: (a) => resumeClaudeTaskToolInstance.handler(a),
          getHandoff: () => getHandoffNoteToolInstance.handler({}),
          getContext: () => getProjectContextToolInstance.handler({}),
          getDiagnostics: () => diagnosticsTool.handler({}),
          getPerfReport: getPerformanceReportToolInstance
            ? () => getPerformanceReportToolInstance.handler({})
            : undefined,
          getAnalyticsReport: getAnalyticsReportToolInstance
            ? () => getAnalyticsReportToolInstance.handler({})
            : undefined,
        })
      : null;

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
      config,
      automationHooks,
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
    createGetHoverTool(workspace, extensionClient, config.lspVerbosity),
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
      config.automationPolicyPath ?? undefined,
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
    getHandoffNoteToolInstance,
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
    createBatchGetHoverTool(workspace, extensionClient, config.lspVerbosity),
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
    getProjectContextToolInstance,
    createGetSessionUsageTool(transport),
    createSearchToolsTool(transport),
    ...(getAnalyticsReportToolInstance !== null
      ? [getAnalyticsReportToolInstance]
      : []),
    ...(getPerformanceReportToolInstance !== null
      ? [getPerformanceReportToolInstance]
      : []),
    createSpawnWorkspaceTool(),
    createPreviewEditTool(workspace),
    ...(() => {
      const tx = createTransactionTools(workspace);
      return [
        tx.beginTransaction,
        tx.stageEdit,
        tx.commitTransaction,
        tx.rollbackTransaction,
      ];
    })(),
    createGetDiffFromHandoffTool(workspace, extensionClient),
    createExplainDiagnosticTool(workspace, extensionClient),
    createFindRelatedTestsTool(workspace, probes),
    createTestTraceToSourceTool(workspace),
    createScreenshotAndAnnotateTool(workspace, extensionClient),
    createGetPRTemplateTool(workspace),
    createEnrichCommitTool(workspace, commitIssueLinkLog),
    createEnrichStackTraceTool(workspace),
    createCtxQueryTracesTool({
      activityLog: activityLog ?? null,
      commitIssueLinkLog: commitIssueLinkLog ?? null,
      recipeRunLog: recipeRunLog ?? null,
    }),
    createCtxGetTaskContextTool({
      workspace,
      commitIssueLinkLog: commitIssueLinkLog ?? null,
    }),
    ...(commitIssueLinkLog
      ? [createGetCommitsForIssueTool(workspace, commitIssueLinkLog)]
      : []),
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
    ...(orchestrator !== null && runClaudeTaskToolInstance !== null
      ? [
          runClaudeTaskToolInstance,
          createGetClaudeTaskStatusTool(orchestrator, sessionId),
          createCancelClaudeTaskTool(orchestrator, sessionId),
          createListClaudeTasksTool(orchestrator, sessionId),
          ...(resumeClaudeTaskToolInstance
            ? [resumeClaudeTaskToolInstance]
            : []),
          ...(launchQuickTaskToolInstance ? [launchQuickTaskToolInstance] : []),
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

  // Apply category tags for searchTools discovery.
  transport.applyToolCategories(TOOL_CATEGORIES);
}

/**
 * Category map for searchTools discovery.
 * Maps tool name → category list. Categories: lsp, git, terminal, debug,
 * editor, analysis, github, bridge, automation, http.
 */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  // LSP / code intelligence
  getDiagnostics: ["lsp", "analysis"],
  watchDiagnostics: ["lsp", "analysis"],
  getDocumentSymbols: ["lsp"],
  goToDefinition: ["lsp"],
  findReferences: ["lsp"],
  findImplementations: ["lsp"],
  goToTypeDefinition: ["lsp"],
  goToDeclaration: ["lsp"],
  getHover: ["lsp"],
  getCodeActions: ["lsp"],
  applyCodeAction: ["lsp"],
  previewCodeAction: ["lsp"],
  refactorPreview: ["lsp"],
  renameSymbol: ["lsp"],
  searchWorkspaceSymbols: ["lsp"],
  getCallHierarchy: ["lsp"],
  explainSymbol: ["lsp"],
  prepareRename: ["lsp"],
  signatureHelp: ["lsp"],
  refactorAnalyze: ["lsp"],
  selectionRanges: ["lsp"],
  foldingRanges: ["lsp"],
  refactorExtractFunction: ["lsp"],
  getImportTree: ["lsp"],
  getImportedSignatures: ["lsp"],
  getDocumentLinks: ["lsp"],
  batchGetHover: ["lsp"],
  batchGoToDefinition: ["lsp"],
  batchFindImplementations: ["lsp"],
  getSemanticTokens: ["lsp"],
  getCodeLens: ["lsp"],
  getChangeImpact: ["lsp", "analysis"],
  getTypeHierarchy: ["lsp"],
  getInlayHints: ["lsp"],
  getHoverAtCursor: ["lsp"],
  getTypeSignature: ["lsp"],
  // Git
  getGitStatus: ["git"],
  getGitDiff: ["git"],
  getGitLog: ["git"],
  getCommitDetails: ["git"],
  getDiffBetweenRefs: ["git"],
  gitAdd: ["git"],
  gitCommit: ["git"],
  gitCheckout: ["git"],
  gitBlame: ["git"],
  gitFetch: ["git"],
  gitListBranches: ["git"],
  gitPull: ["git"],
  gitPush: ["git"],
  gitStash: ["git"],
  gitStashPop: ["git"],
  gitStashList: ["git"],
  getGitHotspots: ["git", "analysis"],
  getSymbolHistory: ["git", "lsp"],
  // Terminal / shell
  runInTerminal: ["terminal"],
  getTerminalOutput: ["terminal"],
  sendTerminalCommand: ["terminal"],
  waitForTerminalOutput: ["terminal"],
  createTerminal: ["terminal"],
  disposeTerminal: ["terminal"],
  listTerminals: ["terminal"],
  runCommand: ["terminal"],
  // Debug
  getDebugState: ["debug"],
  evaluateInDebugger: ["debug"],
  setDebugBreakpoints: ["debug"],
  startDebugging: ["debug"],
  stopDebugging: ["debug"],
  // Editor state
  getOpenEditors: ["editor"],
  getCurrentSelection: ["editor"],
  getLatestSelection: ["editor"],
  checkDocumentDirty: ["editor"],
  saveDocument: ["editor"],
  openFile: ["editor"],
  closeTab: ["editor"],
  captureScreenshot: ["editor"],
  setEditorDecorations: ["editor"],
  clearEditorDecorations: ["editor"],
  openDiff: ["editor"],
  openInBrowser: ["editor"],
  executeVSCodeCommand: ["editor"],
  listVSCodeCommands: ["editor"],
  listVSCodeTasks: ["editor"],
  runVSCodeTask: ["editor"],
  getWorkspaceFolders: ["editor"],
  setActiveWorkspaceFolder: ["editor"],
  getWorkspaceSettings: ["editor"],
  setWorkspaceSetting: ["editor"],
  formatDocument: ["editor", "lsp"],
  formatRange: ["editor", "lsp"],
  formatAndSave: ["editor", "lsp"],
  fixAllLintErrors: ["editor", "lsp"],
  organizeImports: ["editor", "lsp"],
  // File operations
  getBufferContent: ["editor"],
  editText: ["editor"],
  createFile: ["editor"],
  deleteFile: ["editor"],
  renameFile: ["editor"],
  replaceBlock: ["editor"],
  searchAndReplace: ["editor"],
  findFiles: ["editor"],
  getFileTree: ["editor"],
  // Analysis / quality
  runTests: ["analysis"],
  getCodeCoverage: ["analysis"],
  detectUnusedCode: ["analysis"],
  auditDependencies: ["analysis"],
  getSecurityAdvisories: ["analysis"],
  generateTests: ["analysis"],
  generateAPIDocumentation: ["analysis"],
  findRelatedTests: ["analysis"],
  getDependencyTree: ["analysis"],
  getGitHotspot: ["analysis", "git"],
  screenshotAndAnnotate: ["analysis", "editor"],
  // GitHub
  githubCreatePR: ["github"],
  githubListPRs: ["github"],
  githubViewPR: ["github"],
  githubListIssues: ["github"],
  githubGetIssue: ["github"],
  githubCreateIssue: ["github"],
  githubCommentIssue: ["github"],
  githubListRuns: ["github"],
  githubGetRunLogs: ["github"],
  githubGetPRDiff: ["github"],
  githubPostPRReview: ["github"],
  getPRTemplate: ["github"],
  enrichCommit: ["github"],
  getCommitsForIssue: ["github"],
  getAIComments: ["github"],
  createGithubIssueFromAIComment: ["github"],
  // Bridge / orchestration
  getBridgeStatus: ["bridge"],
  getToolCapabilities: ["bridge"],
  bridgeDoctor: ["bridge"],
  getSessionUsage: ["bridge"],
  searchTools: ["bridge"],
  getProjectInfo: ["bridge"],
  getProjectContext: ["bridge"],
  getArchitectureContext: ["bridge"],
  contextBundle: ["bridge"],
  watchActivityLog: ["bridge"],
  getActivityLog: ["bridge"],
  getAnalyticsReport: ["bridge"],
  getHandoffNote: ["bridge"],
  setHandoffNote: ["bridge"],
  // Claude orchestration
  runClaudeTask: ["automation"],
  getClaudeTaskStatus: ["automation"],
  cancelClaudeTask: ["automation"],
  listClaudeTasks: ["automation"],
  resumeClaudeTask: ["automation"],
  // HTTP
  sendHttpRequest: ["http"],
  parseHttpFile: ["http"],
  // Clipboard
  readClipboard: ["editor"],
  writeClipboard: ["editor"],
  // Plans
  createPlan: ["bridge"],
  updatePlan: ["bridge"],
  deletePlan: ["bridge"],
  getPlan: ["bridge"],
  listPlans: ["bridge"],
  // Navigation helpers
  jumpToFirstError: ["lsp"],
  navigateToSymbolByName: ["lsp"],
  // File watching
  watchFiles: ["editor"],
  unwatchFiles: ["editor"],
  // Search
  searchWorkspace: ["analysis"],
};
