import type { RequestHandler } from "../types";
import { handleGetAIComments } from "./aiComments";
import { handleReadClipboard, handleWriteClipboard } from "./clipboard";
import {
  handleFixAllLintErrors,
  handleFormatDocument,
  handleOrganizeImports,
} from "./codeActions";
import { handleGetCodeLens } from "./codeLens";
import { handleGetDiagnostics } from "./diagnostics";
import { handleGetDocumentLinks } from "./documentLinks";
import { handleEditText, handleReplaceBlock } from "./editText";
import {
  handleCloseTab,
  handleCreateFile,
  handleDeleteFile,
  handleGetFileContent,
  handleGetOpenFiles,
  handleGetWorkspaceFolders,
  handleIsDirty,
  handleOpenFile,
  handleRenameFile,
  handleSaveFile,
} from "./files";
import { handleGetInlayHints } from "./inlayHints";
import { handleCaptureScreenshot } from "./screenshot";
import { handleGetSelection } from "./selection";
import { handleGetSemanticTokens } from "./semanticTokens";
import { handleListTasks, handleRunTask } from "./tasks";
import {
  handleCreateTerminal,
  handleDisposeTerminal,
  handleExecuteInTerminal,
  handleGetTerminalOutput,
  handleListTerminals,
  handleSendTerminalCommand,
  handleWaitForTerminalOutput,
} from "./terminal";
import { handleGetTypeHierarchy } from "./typeHierarchy";
import {
  handleExecuteVSCodeCommand,
  handleListVSCodeCommands,
} from "./vscodeCommands";
import {
  handleGetWorkspaceSettings,
  handleSetWorkspaceSetting,
} from "./workspaceSettings";

// Base handlers that need no DI
export const baseHandlers: Record<string, RequestHandler> = {
  "extension/getDiagnostics": handleGetDiagnostics,
  "extension/getSelection": handleGetSelection,
  "extension/getOpenFiles": handleGetOpenFiles,
  "extension/isDirty": handleIsDirty,
  "extension/getFileContent": handleGetFileContent,
  "extension/openFile": handleOpenFile,
  "extension/saveFile": handleSaveFile,
  "extension/closeTab": handleCloseTab,
  "extension/getAIComments": handleGetAIComments,
  "extension/listTerminals": handleListTerminals,
  "extension/getTerminalOutput": handleGetTerminalOutput,
  // Phase 2: Write/Act capabilities
  "extension/createFile": handleCreateFile,
  "extension/deleteFile": handleDeleteFile,
  "extension/renameFile": handleRenameFile,
  "extension/editText": handleEditText,
  "extension/replaceBlock": handleReplaceBlock,
  "extension/createTerminal": handleCreateTerminal,
  "extension/disposeTerminal": handleDisposeTerminal,
  "extension/sendTerminalCommand": handleSendTerminalCommand,
  "extension/executeInTerminal": handleExecuteInTerminal,
  "extension/waitForTerminalOutput": handleWaitForTerminalOutput,
  // Phase 3: Code actions (format, fix, organize)
  "extension/formatDocument": handleFormatDocument,
  "extension/fixAllLintErrors": handleFixAllLintErrors,
  "extension/organizeImports": handleOrganizeImports,
  // Phase 4: Additional features
  "extension/readClipboard": handleReadClipboard,
  "extension/writeClipboard": handleWriteClipboard,
  "extension/getWorkspaceSettings": handleGetWorkspaceSettings,
  "extension/setWorkspaceSetting": handleSetWorkspaceSetting,
  "extension/executeVSCodeCommand": handleExecuteVSCodeCommand,
  "extension/listVSCodeCommands": handleListVSCodeCommands,
  "extension/getInlayHints": handleGetInlayHints,
  "extension/getTypeHierarchy": handleGetTypeHierarchy,
  "extension/getSemanticTokens": handleGetSemanticTokens,
  "extension/getCodeLens": handleGetCodeLens,
  "extension/getDocumentLinks": handleGetDocumentLinks,
  "extension/getWorkspaceFolders": handleGetWorkspaceFolders,
  "extension/captureScreenshot": handleCaptureScreenshot,
  "extension/listTasks": handleListTasks,
  "extension/runTask": (params) =>
    handleRunTask(params as Record<string, unknown>),
};
