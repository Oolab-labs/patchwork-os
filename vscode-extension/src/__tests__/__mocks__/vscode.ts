/**
 * Minimal vscode namespace mock for handler testing.
 * Only mocks what the extension handlers actually use.
 * Resolved via vitest alias so handler source code needs zero changes.
 */
import { vi } from "vitest";

// ── Constructors ──────────────────────────────────────────────

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  );
  constructor(start: Position, end: Position);
  constructor(
    startOrLine: Position | number,
    endOrChar: Position | number,
    endLine?: number,
    endChar?: number,
  ) {
    if (typeof startOrLine === "number") {
      this.start = new Position(startOrLine, endOrChar as number);
      this.end = new Position(endLine!, endChar!);
    } else {
      this.start = startOrLine;
      this.end = endOrChar as Position;
    }
  }
}

export class WorkspaceEdit {
  private _operations: Array<{ type: string; uri: any; args: any[] }> = [];

  insert(uri: any, position: Position, text: string) {
    this._operations.push({ type: "insert", uri, args: [position, text] });
  }
  delete(uri: any, range: Range) {
    this._operations.push({ type: "delete", uri, args: [range] });
  }
  replace(uri: any, range: Range, text: string) {
    this._operations.push({ type: "replace", uri, args: [range, text] });
  }
  createFile(uri: any, options?: any) {
    this._operations.push({ type: "createFile", uri, args: [options] });
  }
  renameFile(oldUri: any, newUri: any, options?: any) {
    this._operations.push({
      type: "renameFile",
      uri: oldUri,
      args: [newUri, options],
    });
  }
  entries(): Array<[any, any[]]> {
    return (this as any).__entries ?? [];
  }

  /** Test helper: get all recorded operations */
  _getOperations() {
    return this._operations;
  }
}

export class TabInputText {
  constructor(public readonly uri: { fsPath: string; toString(): string }) {}
}

export class RelativePattern {
  constructor(
    public readonly base: any,
    public readonly pattern: string,
  ) {}
}

// ── Enums ─────────────────────────────────────────────────────

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

// SymbolKind needs numeric keys mapping to string names (used as SymbolKind[kind])
export const SymbolKind: Record<number, string> &
  Record<string, number | string> = {
  0: "File",
  File: 0,
  1: "Module",
  Module: 1,
  2: "Namespace",
  Namespace: 2,
  3: "Package",
  Package: 3,
  4: "Class",
  Class: 4,
  5: "Method",
  Method: 5,
  6: "Property",
  Property: 6,
  7: "Field",
  Field: 7,
  8: "Constructor",
  Constructor: 8,
  9: "Enum",
  Enum: 9,
  10: "Interface",
  Interface: 10,
  11: "Function",
  Function: 11,
  12: "Variable",
  Variable: 12,
  13: "Constant",
  Constant: 13,
  14: "String",
  String: 14,
  15: "Number",
  Number: 15,
  16: "Boolean",
  Boolean: 16,
  17: "Array",
  Array: 17,
};

export const InlayHintKind = {
  Type: 1,
  Parameter: 2,
} as const;

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const CodeActionKind = {
  SourceFixAll: { value: "source.fixAll" },
  SourceOrganizeImports: { value: "source.organizeImports" },
};

export const NotebookCellKind = {
  Markup: 1,
  Code: 2,
} as const;

export const NotebookCellExecutionState = {
  Idle: 1,
  Pending: 2,
  Executing: 3,
} as const;

export const OverviewRulerLane = {
  Left: 1,
  Center: 2,
  Right: 4,
  Full: 7,
} as const;

export class ThemeColor {
  constructor(public readonly id: string) {}
}

// ── Uri ───────────────────────────────────────────────────────

export const Uri = {
  file: (p: string) => ({
    fsPath: p,
    toString: () => `file://${p}`,
    scheme: "file",
  }),
  parse: (s: string) => {
    const fsPath = s.startsWith("file://") ? s.slice(7) : s;
    return { fsPath, toString: () => s, scheme: "file" };
  },
};

// ── Mock FileSystemWatcher ────────────────────────────────────

function createMockWatcher() {
  const listeners: Record<string, Function[]> = {
    create: [],
    change: [],
    delete: [],
  };
  return {
    onDidCreate: (fn: Function) => {
      listeners.create.push(fn);
      return { dispose: vi.fn() };
    },
    onDidChange: (fn: Function) => {
      listeners.change.push(fn);
      return { dispose: vi.fn() };
    },
    onDidDelete: (fn: Function) => {
      listeners.delete.push(fn);
      return { dispose: vi.fn() };
    },
    dispose: vi.fn(),
    _fire: (event: string, uri: any) =>
      listeners[event]?.forEach((fn) => {
        fn(uri);
      }),
    _listeners: listeners,
  };
}

// ── Namespace stubs ───────────────────────────────────────────

export const workspace = {
  workspaceFolders: undefined as any[] | undefined,
  isTrusted: true,
  textDocuments: [] as any[],
  openTextDocument: vi.fn(async () => _mockTextDocument()),
  openNotebookDocument: vi.fn(async () => ({
    getCells: () => [],
    cellAt: vi.fn(() => null),
    cellCount: 0,
  })),
  applyEdit: vi.fn(async () => true),
  fs: {
    createDirectory: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
  createFileSystemWatcher: vi.fn(() => createMockWatcher()),
  onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  getConfiguration: vi.fn((_section?: string) => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  })),
};

export const window = {
  tabGroups: {
    all: [] as any[],
    close: vi.fn(async () => true),
  },
  terminals: [] as any[],
  activeTerminal: undefined as any,
  activeTextEditor: undefined as any,
  showTextDocument: vi.fn(async (_doc: any, _opts?: any) => _mockTextEditor()),
  createTerminal: vi.fn((_opts?: any) => _mockTerminal()),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  createStatusBarItem: vi.fn(() => ({
    text: "",
    tooltip: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showNotebookDocument: vi.fn(async () => undefined),
  onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  onDidOpenTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidEndTerminalShellExecution: vi.fn((_handler: (event: any) => void) => ({
    dispose: vi.fn(),
  })),
  onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
  visibleTextEditors: [] as any[],
  createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
};

export const notebooks = {
  onDidChangeNotebookCellExecutionState: vi.fn(() => ({ dispose: vi.fn() })),
};

export const languages = {
  getDiagnostics: vi.fn(() => []),
  onDidChangeDiagnostics: vi.fn(() => ({ dispose: vi.fn() })),
};

/** Create a mock DebugSession */
export function _mockDebugSession(
  overrides: Partial<{
    id: string;
    name: string;
    type: string;
    customRequest: (command: string, args?: unknown) => Promise<unknown>;
  }> = {},
) {
  return {
    id: overrides.id ?? "session-1",
    name: overrides.name ?? "Mock Session",
    type: overrides.type ?? "node",
    customRequest: overrides.customRequest ?? vi.fn(async () => ({})),
  };
}

export const debug = {
  activeDebugSession: undefined as
    | ReturnType<typeof _mockDebugSession>
    | undefined,
  breakpoints: [] as any[],
  onDidStartDebugSession: vi.fn(() => ({ dispose: vi.fn() })),
  onDidTerminateDebugSession: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeActiveDebugSession: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeBreakpoints: vi.fn(() => ({ dispose: vi.fn() })),
  startDebugging: vi.fn(async () => true),
  stopDebugging: vi.fn(async () => {}),
  addBreakpoints: vi.fn(),
  removeBreakpoints: vi.fn(),
};

export const commands = {
  executeCommand: vi.fn(async () => undefined),
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  getCommands: vi.fn(async () => [] as string[]),
};

export const env = {
  clipboard: {
    writeText: vi.fn(async () => {}),
    readText: vi.fn(async () => ""),
  },
};

export const version = "1.85.0";

// ── Test helpers ──────────────────────────────────────────────

/** Create a mock TextDocument */
export function _mockTextDocument(
  overrides: Partial<{
    uri: any;
    fsPath: string;
    isDirty: boolean;
    isUntitled: boolean;
    lineCount: number;
    getText: (range?: any) => string;
    lineAt: (line: number) => { text: string };
    save: () => Promise<boolean>;
  }> = {},
) {
  const fsPath = overrides.fsPath ?? "/mock/file.ts";
  const uri = overrides.uri ?? Uri.file(fsPath);
  return {
    uri,
    isDirty: overrides.isDirty ?? false,
    isUntitled: overrides.isUntitled ?? false,
    lineCount: overrides.lineCount ?? 10,
    getText: overrides.getText ?? (() => ""),
    lineAt: overrides.lineAt ?? ((n: number) => ({ text: `line ${n}` })),
    save: overrides.save ?? vi.fn(async () => true),
  };
}

/** Create a mock TextEditor */
export function _mockTextEditor(
  overrides: Partial<{
    document: any;
    selection: any;
    options: any;
  }> = {},
) {
  const doc = overrides.document ?? _mockTextDocument();
  return {
    document: doc,
    selection: overrides.selection ?? {
      start: new Position(0, 0),
      end: new Position(0, 0),
    },
    options: overrides.options ?? {
      tabSize: 2,
      insertSpaces: true,
    },
  };
}

/** Create a mock Terminal */
export function _mockTerminal(
  overrides: Partial<{
    name: string;
    show: () => void;
    sendText: (text: string, addNewline?: boolean) => void;
  }> = {},
) {
  return {
    name: overrides.name ?? "Terminal",
    show: overrides.show ?? vi.fn(),
    sendText: overrides.sendText ?? vi.fn(),
  };
}

/** Reset all mocks to defaults. Call in beforeEach(). */
export function __reset() {
  workspace.isTrusted = true;
  workspace.workspaceFolders = [
    { uri: { fsPath: "/workspace" } },
    { uri: { fsPath: "/test-root" } },
  ] as any;
  workspace.textDocuments = [];
  workspace.openTextDocument
    .mockReset()
    .mockImplementation(async () => _mockTextDocument());
  workspace.applyEdit.mockReset().mockResolvedValue(true);
  workspace.fs.createDirectory.mockReset().mockResolvedValue(undefined);
  workspace.fs.delete.mockReset().mockResolvedValue(undefined);
  workspace.createFileSystemWatcher
    .mockReset()
    .mockImplementation(() => createMockWatcher());
  workspace.onDidChangeTextDocument
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  workspace.onDidOpenTextDocument
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  workspace.onDidSaveTextDocument
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  workspace.onDidChangeWorkspaceFolders
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  workspace.getConfiguration
    .mockReset()
    .mockImplementation((_section?: string) => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      inspect: vi.fn(() => undefined),
      update: vi.fn(async () => {}),
    }));

  window.tabGroups.all = [];
  window.tabGroups.close.mockReset().mockResolvedValue(true);
  window.terminals = [];
  window.activeTerminal = undefined;
  window.activeTextEditor = undefined;
  window.showTextDocument
    .mockReset()
    .mockImplementation(async () => _mockTextEditor());
  window.createTerminal.mockReset().mockImplementation(() => _mockTerminal());
  window.showInformationMessage.mockReset();
  window.showWarningMessage.mockReset();
  window.showErrorMessage.mockReset();
  window.onDidEndTerminalShellExecution
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });

  workspace.openNotebookDocument.mockReset().mockImplementation(async () => ({
    getCells: () => [],
    cellAt: vi.fn(() => null),
    cellCount: 0,
  }));

  window.showNotebookDocument.mockReset().mockResolvedValue(undefined);
  window.onDidChangeVisibleTextEditors
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  window.visibleTextEditors = [];
  window.createTextEditorDecorationType
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });

  notebooks.onDidChangeNotebookCellExecutionState
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });

  languages.getDiagnostics.mockReset().mockReturnValue([]);
  commands.executeCommand.mockReset().mockResolvedValue(undefined);
  commands.registerCommand.mockReset().mockReturnValue({ dispose: vi.fn() });
  commands.getCommands.mockReset().mockResolvedValue([]);
  env.clipboard.readText.mockReset().mockResolvedValue("");
  env.clipboard.writeText.mockReset();

  debug.activeDebugSession = undefined;
  debug.breakpoints = [];
  debug.onDidStartDebugSession
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  debug.onDidTerminateDebugSession
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  debug.onDidChangeActiveDebugSession
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  debug.onDidChangeBreakpoints
    .mockReset()
    .mockReturnValue({ dispose: vi.fn() });
  debug.startDebugging.mockReset().mockResolvedValue(true);
  debug.stopDebugging.mockReset().mockResolvedValue(undefined);
  debug.addBreakpoints.mockReset();
  debug.removeBreakpoints.mockReset();
}
