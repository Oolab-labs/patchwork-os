import type { RequestHandler } from "../types";
import { handleGetDiagnostics } from "./diagnostics";
import { handleGetSelection } from "./selection";
import { handleGetOpenFiles, handleIsDirty, handleOpenFile, handleSaveFile, handleCloseTab, handleGetFileContent, handleCreateFile, handleDeleteFile, handleRenameFile, handleGetWorkspaceFolders } from "./files";
import { handleGetAIComments } from "./aiComments";
import { handleListTerminals, handleGetTerminalOutput, handleCreateTerminal, handleDisposeTerminal, handleSendTerminalCommand, handleExecuteInTerminal, handleWaitForTerminalOutput } from "./terminal";
import { handleEditText, handleReplaceBlock } from "./editText";
import { handleFormatDocument, handleFixAllLintErrors, handleOrganizeImports } from "./codeActions";
import { handleReadClipboard, handleWriteClipboard } from "./clipboard";
import { handleGetWorkspaceSettings, handleSetWorkspaceSetting } from "./workspaceSettings";
import { handleExecuteVSCodeCommand, handleListVSCodeCommands } from "./vscodeCommands";
import { handleGetInlayHints } from "./inlayHints";
import { handleGetTypeHierarchy } from "./typeHierarchy";

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
  "extension/getWorkspaceFolders": handleGetWorkspaceFolders,
};
