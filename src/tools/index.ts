import type { ActivityLog } from "../activityLog.js";
import type { Config } from "../config.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import type { McpTransport, ToolHandler } from "../transport.js";
import { createGetActivityLogTool } from "./activityLog.js";
import { createBridgeStatusTool } from "./bridgeStatus.js";
import { createGetAICommentsTool } from "./aiComments.js";
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
import { createDiffDebugTool } from "./diffDebugger.js";
import { createEditTextTool } from "./editText.js";
import {
  createCreateFileTool,
  createDeleteFileTool,
  createRenameFileTool,
} from "./fileOperations.js";
import { createUnwatchFilesTool, createWatchFilesTool } from "./fileWatcher.js";
import { createFindFilesTool } from "./findFiles.js";
import { createFixAllLintErrorsTool } from "./fixAllLintErrors.js";
import { createCheckScopeTool, createExpandScopeTool } from "./flowGuardian.js";
import { createFormatDocumentTool } from "./formatDocument.js";
import { createGetBufferContentTool } from "./getBufferContent.js";
import {
  createGetCurrentSelectionTool,
  createGetLatestSelectionTool,
} from "./getCurrentSelection.js";
import { createGetDiagnosticsTool } from "./getDiagnostics.js";
import { createGetDocumentSymbolsTool } from "./getDocumentSymbols.js";
import { createGetFileTreeTool } from "./getFileTree.js";
import { createGetGitDiffTool } from "./getGitDiff.js";
import { createGetGitLogTool } from "./getGitLog.js";
import { createGetGitStatusTool } from "./getGitStatus.js";
import { createGetOpenEditorsTool } from "./getOpenEditors.js";
import { createGetProjectInfoTool } from "./getProjectInfo.js";
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
import { createGetHoverAtCursorTool } from "./hoverAtCursor.js";
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
import {
  createCreateSnapshotTool,
  createDeleteSnapshotTool,
  createDiffSnapshotTool,
  createListSnapshotsTool,
  createRestoreSnapshotTool,
  createShowSnapshotTool,
} from "./workspaceSnapshots.js";

export function registerAllTools(
  transport: McpTransport,
  config: Config,
  openedFiles: Set<string>,
  probes: ProbeResults,
  extensionClient: ExtensionClient,
  activityLog?: ActivityLog,
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

  // Combined handler that merges lint diagnostics + test failures for diffDebugger.
  // Uses allSettled so one failing doesn't lose the other's results.
  const combinedDiagnosticsFn: ToolHandler = async (_args, signal) => {
    const [diagSettled, testSettled] = await Promise.allSettled([
      diagnosticsTool.handler({}, signal),
      testsTool.handler({}, signal),
    ]);

    const warnings: string[] = [];
    let diagnostics: unknown[] = [];

    // Parse diagnostics from the lint result
    if (diagSettled.status === "fulfilled") {
      try {
        const rawText = diagSettled.value.content?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          diagnostics = parsed.diagnostics ?? [];
        }
      } catch (e) {
        warnings.push(
          `Failed to parse lint diagnostics: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      warnings.push(
        `Lint diagnostics failed: ${diagSettled.reason instanceof Error ? diagSettled.reason.message : String(diagSettled.reason)}`,
      );
    }

    // Convert test failures to diagnostic shape and merge
    if (testSettled.status === "fulfilled") {
      try {
        const rawText = testSettled.value.content?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          const failures = parsed.failures ?? [];
          for (const f of failures) {
            diagnostics.push({
              file: f.file ?? "",
              line: f.line ?? 1,
              column: f.column ?? 1,
              severity: "error",
              message: `[${f.source}] ${f.name}: ${f.message}`,
              source: f.source,
            });
          }
        }
      } catch (e) {
        warnings.push(
          `Failed to parse test results: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      warnings.push(
        `Test runner failed: ${testSettled.reason instanceof Error ? testSettled.reason.message : String(testSettled.reason)}`,
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            diagnostics,
            ...(warnings.length > 0 && { warnings }),
          }),
        },
      ],
    };
  };

  const tools = [
    createOpenFileTool(
      workspace,
      config.editorCommand,
      openedFiles,
      extensionClient,
    ),
    createOpenDiffTool(workspace, config.editorCommand),
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
    createGetAICommentsTool(workspace, extensionClient),
    createCheckScopeTool(workspace),
    createExpandScopeTool(workspace),
    createCreateSnapshotTool(workspace),
    createListSnapshotsTool(workspace),
    createDiffSnapshotTool(workspace),
    createRestoreSnapshotTool(workspace),
    createDeleteSnapshotTool(workspace),
    createShowSnapshotTool(workspace),
    testsTool,
    createDiffDebugTool(workspace, combinedDiagnosticsFn),
    ...(activityLog ? [createGetActivityLogTool(activityLog)] : []),
    createBridgeStatusTool(extensionClient),
    createWatchFilesTool(extensionClient),
    createUnwatchFilesTool(extensionClient),
    createListTerminalsTool(extensionClient),
    createGetTerminalOutputTool(extensionClient),
    createCreateTerminalTool(workspace, extensionClient),
    createDisposeTerminalTool(extensionClient),
    createSendTerminalCommandTool(extensionClient, config.commandAllowlist),
    createRunInTerminalTool(extensionClient, config.commandAllowlist),
    createWaitForTerminalOutputTool(extensionClient),
    createCreateFileTool(workspace, extensionClient),
    createDeleteFileTool(workspace, extensionClient),
    createRenameFileTool(workspace, extensionClient),
    createGetBufferContentTool(workspace, extensionClient),
    createReplaceBlockTool(workspace, extensionClient),
    createEditTextTool(workspace, extensionClient),
    createFormatDocumentTool(workspace, probes, extensionClient),
    createFixAllLintErrorsTool(workspace, probes, extensionClient),
    createOrganizeImportsTool(workspace, extensionClient),
    createWatchDiagnosticsTool(workspace, extensionClient),
    // Phase 4: Additional features
    createReadClipboardTool(extensionClient),
    createWriteClipboardTool(extensionClient),
    createGetWorkspaceSettingsTool(extensionClient),
    createSetWorkspaceSettingTool(extensionClient),
    createExecuteVSCodeCommandTool(extensionClient, config),
    createListVSCodeCommandsTool(extensionClient),
    createGetInlayHintsTool(workspace, extensionClient),
    createGetHoverAtCursorTool(extensionClient),
    createGetTypeHierarchyTool(workspace, extensionClient),
    createGetDebugStateTool(extensionClient),
    createEvaluateInDebuggerTool(extensionClient),
    createSetDebugBreakpointsTool(workspace, extensionClient),
    createStartDebuggingTool(extensionClient),
    createStopDebuggingTool(extensionClient),
    createSetEditorDecorationsTool(workspace, extensionClient),
    createClearEditorDecorationsTool(extensionClient),
    createListTasksTool(extensionClient),
    createRunTaskTool(extensionClient),
    createSetActiveWorkspaceFolderTool(config),
    createGetNotebookCellsTool(workspace, extensionClient),
    createRunNotebookCellTool(workspace, extensionClient),
    createGetNotebookOutputTool(workspace, extensionClient),
    createSendHttpRequestTool(),
    createParseHttpFileTool(workspace),
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
