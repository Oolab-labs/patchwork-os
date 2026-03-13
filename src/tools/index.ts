import type { ActivityLog } from "../activityLog.js";
import type { Config } from "../config.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { FileLock } from "../fileLock.js";
import type { ProbeResults } from "../probe.js";
import type { McpTransport } from "../transport.js";
import { createGetActivityLogTool } from "./activityLog.js";
import { createBridgeStatusTool } from "./bridgeStatus.js";
import { createCheckDocumentDirtyTool } from "./checkDocumentDirty.js";
import {
  createReadClipboardTool,
  createWriteClipboardTool,
} from "./clipboard.js";
import { createCloseAllDiffTabsTool, createCloseTabTool } from "./closeTabs.js";
import {
  createEvaluateInDebuggerTool,
  createGetDebugStateTool,
  createSetDebugBreakpointsTool,
  createStartDebuggingTool,
  createStopDebuggingTool,
} from "./debug.js";
import {
  createClearEditorDecorationsTool,
  createSetEditorDecorationsTool,
} from "./decorations.js";
import { createEditTextTool } from "./editText.js";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createRenameFileTool,
} from "./fileOperations.js";
import { createUnwatchFilesTool, createWatchFilesTool } from "./fileWatcher.js";
import { createFindFilesTool } from "./findFiles.js";
import { createFixAllLintErrorsTool } from "./fixAllLintErrors.js";
import { createFormatDocumentTool } from "./formatDocument.js";
import { createGetBufferContentTool } from "./getBufferContent.js";
import {
  createGetCurrentSelectionTool,
  createGetLatestSelectionTool,
} from "./getCurrentSelection.js";
import { createGenerateTestsTool } from "./generateTests.js";
import { createGetCodeCoverageTool } from "./getCodeCoverage.js";
import { createGetDependencyTreeTool } from "./getDependencyTree.js";
import { createGetDiagnosticsTool } from "./getDiagnostics.js";
import { createGetDocumentSymbolsTool } from "./getDocumentSymbols.js";
import { createGetFileTreeTool } from "./getFileTree.js";
import { createGetGitDiffTool } from "./getGitDiff.js";
import { createGetGitHotspotsTool } from "./getGitHotspots.js";
import { createGetGitLogTool } from "./getGitLog.js";
import { createGetGitStatusTool } from "./getGitStatus.js";
import { createGetOpenEditorsTool } from "./getOpenEditors.js";
import { createGetPRTemplateTool } from "./getPRTemplate.js";
import { createGetProjectInfoTool } from "./getProjectInfo.js";
import { createGetSecurityAdvisoriesTool } from "./getSecurityAdvisories.js";
import { createGetToolCapabilitiesTool } from "./getToolCapabilities.js";
import { createGetWorkspaceFoldersTool } from "./getWorkspaceFolders.js";
import {
  createGetCommitDetailsTool,
  createGetDiffBetweenRefsTool,
} from "./gitHistory.js";
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
import { createCreateIssueFromAICommentTool } from "./createIssueFromAIComment.js";
import { createGetHoverAtCursorTool } from "./hoverAtCursor.js";
import { createGetImportTreeTool } from "./getImportTree.js";
import { createGetTypeSignatureTool } from "./getTypeSignature.js";
import {
  createParseHttpFileTool,
  createSendHttpRequestTool,
} from "./httpClient.js";
import { createGetInlayHintsTool } from "./inlayHints.js";
import {
  createApplyCodeActionTool,
  createFindReferencesTool,
  createGetCallHierarchyTool,
  createGetCodeActionsTool,
  createGetHoverTool,
  createGoToDefinitionTool,
  createRenameSymbolTool,
  createSearchWorkspaceSymbolsTool,
} from "./lsp.js";
import {
  createGetNotebookCellsTool,
  createGetNotebookOutputTool,
  createRunNotebookCellTool,
} from "./notebook.js";
import { createOpenDiffTool } from "./openDiff.js";
import { createOpenFileTool } from "./openFile.js";
import { createOpenInBrowserTool } from "./openInBrowser.js";
import { createOrganizeImportsTool } from "./organizeImports.js";
import { createPlanTools } from "./planPersistence.js";
import { createReplaceBlockTool } from "./replaceBlock.js";
import { createRunCommandTool } from "./runCommand.js";
import { createRunTestsTool } from "./runTests.js";
import { createSaveDocumentTool } from "./saveDocument.js";
import { createSearchAndReplaceTool } from "./searchAndReplace.js";
import { createSearchWorkspaceTool } from "./searchWorkspace.js";
import { createSetActiveWorkspaceFolderTool } from "./setActiveWorkspaceFolder.js";
import { createListTasksTool, createRunTaskTool } from "./tasks.js";
import {
  createCreateTerminalTool,
  createDisposeTerminalTool,
  createGetTerminalOutputTool,
  createListTerminalsTool,
  createRunInTerminalTool,
  createSendTerminalCommandTool,
  createWaitForTerminalOutputTool,
} from "./terminal.js";
import { createGetTypeHierarchyTool } from "./typeHierarchy.js";
import {
  createExecuteVSCodeCommandTool,
  createListVSCodeCommandsTool,
} from "./vscodeCommands.js";
import { createWatchDiagnosticsTool } from "./watchDiagnostics.js";
import {
  createGetWorkspaceSettingsTool,
  createSetWorkspaceSettingTool,
} from "./workspaceSettings.js";

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
): void {
  const workspace = config.workspace;
  const workspaceFolders = config.workspaceFolders;

  const diagnosticsTool = createGetDiagnosticsTool(
    workspace,
    probes,
    extensionClient,
    config.linters.length > 0 ? config.linters : undefined,
  );

  const testsTool = createRunTestsTool(workspace, probes);

  const tools = [
    createOpenFileTool(
      workspace,
      config.editorCommand,
      openedFiles,
      extensionClient,
    ),
    createOpenDiffTool(workspace, config.editorCommand),
    createOpenInBrowserTool(),
    createGetOpenEditorsTool(openedFiles, extensionClient),
    createGetWorkspaceFoldersTool(workspaceFolders, extensionClient),
    createGetProjectInfoTool(workspace),
    createGetCurrentSelectionTool(extensionClient),
    createGetLatestSelectionTool(extensionClient),
    diagnosticsTool,
    createCheckDocumentDirtyTool(workspace, extensionClient),
    createSaveDocumentTool(workspace, extensionClient),
    createCloseTabTool(workspace, extensionClient),
    createCloseAllDiffTabsTool(),
    createGetToolCapabilitiesTool(probes, extensionClient, config),
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
    createGitCommitTool(workspace),
    createGitCheckoutTool(workspace),
    createGitBlameTool(workspace),
    createGitFetchTool(workspace),
    createGitListBranchesTool(workspace),
    createGitPullTool(workspace),
    createGitPushTool(workspace),
    createGitStashTool(workspace),
    createGitStashPopTool(workspace),
    createGitStashListTool(workspace),
    createRunCommandTool(workspace, config),
    createGetDocumentSymbolsTool(workspace, extensionClient),
    createGoToDefinitionTool(workspace, extensionClient),
    createFindReferencesTool(workspace, extensionClient),
    createGetHoverTool(workspace, extensionClient),
    createGetCodeActionsTool(workspace, extensionClient),
    createApplyCodeActionTool(workspace, extensionClient),
    createRenameSymbolTool(workspace, extensionClient),
    createSearchWorkspaceSymbolsTool(workspace, extensionClient),
    createGetCallHierarchyTool(workspace, extensionClient),
    // The Chosen Five
    ...createPlanTools(workspace),
    testsTool,
    ...(activityLog ? [createGetActivityLogTool(activityLog)] : []),
    createBridgeStatusTool(extensionClient, sessions),
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
      extensionClient,
      config.commandAllowlist,
      terminalPrefix,
    ),
    createWaitForTerminalOutputTool(extensionClient, terminalPrefix),
    createCreateFileTool(workspace, extensionClient),
    createDeleteFileTool(workspace, extensionClient),
    createRenameFileTool(workspace, extensionClient),
    createGetBufferContentTool(workspace, extensionClient),
    createReplaceBlockTool(workspace, extensionClient, fileLock),
    createEditTextTool(workspace, extensionClient, fileLock),
    createFormatDocumentTool(workspace, probes, extensionClient),
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
    createGetWorkspaceSettingsTool(extensionClient),
    createSetWorkspaceSettingTool(extensionClient),
    createExecuteVSCodeCommandTool(extensionClient, config),
    createListVSCodeCommandsTool(extensionClient),
    createGetInlayHintsTool(workspace, extensionClient),
    createGetHoverAtCursorTool(extensionClient),
    createGetTypeSignatureTool(extensionClient),
    createGetImportTreeTool(workspace),
    createGetTypeHierarchyTool(workspace, extensionClient),
    createGetDebugStateTool(extensionClient),
    createEvaluateInDebuggerTool(extensionClient),
    createSetDebugBreakpointsTool(workspace, extensionClient),
    createStartDebuggingTool(extensionClient),
    createStopDebuggingTool(extensionClient),
    createSetEditorDecorationsTool(workspace, extensionClient),
    createClearEditorDecorationsTool(extensionClient),
    createListTasksTool(workspace, extensionClient),
    createRunTaskTool(extensionClient),
    createSetActiveWorkspaceFolderTool(config),
    createGetNotebookCellsTool(workspace, extensionClient),
    createRunNotebookCellTool(workspace, extensionClient),
    createGetNotebookOutputTool(workspace, extensionClient),
    createSendHttpRequestTool(),
    createParseHttpFileTool(workspace),
    // Dependency & security tools
    createGetDependencyTreeTool(workspace, probes),
    createGetSecurityAdvisoriesTool(workspace, probes),
    createGetGitHotspotsTool(workspace),
    createGetPRTemplateTool(workspace),
    createGetCodeCoverageTool(workspace),
    createGenerateTestsTool(workspace),
    ...(probes.gh
      ? [
          createGithubCreatePRTool(workspace),
          createGithubListPRsTool(workspace),
          createGithubViewPRTool(workspace),
          createGithubListIssuesTool(workspace),
          createGithubGetIssueTool(workspace),
          createGithubCreateIssueTool(workspace),
          createGithubCommentIssueTool(workspace),
          createGithubListRunsTool(workspace),
          createGithubGetRunLogsTool(workspace),
          createGithubGetPRDiffTool(workspace),
          createGithubPostPRReviewTool(workspace),
          createCreateIssueFromAICommentTool(
            workspace,
            extensionClient.latestAIComments,
          ),
        ]
      : []),
  ];

  for (const tool of tools) {
    transport.registerTool(
      tool.schema,
      tool.handler,
      (tool as { timeoutMs?: number }).timeoutMs,
    );
  }
}
