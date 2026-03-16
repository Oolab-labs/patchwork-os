import * as vscode from "vscode";
import type { RequestHandler } from "../types";
import { requireNumber, requireString } from "./validation";

type FlatSymbol = {
  name: string;
  kind: string;
  detail: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  selectionLine: number;
  selectionColumn: number;
  parent: string | null;
};

function flattenSymbols(
  syms: vscode.DocumentSymbol[],
  parent: string | null,
): FlatSymbol[] {
  const result: FlatSymbol[] = [];
  for (const sym of syms) {
    result.push({
      name: sym.name,
      kind: vscode.SymbolKind[sym.kind],
      detail: sym.detail || null,
      line: sym.range.start.line + 1,
      column: sym.range.start.character + 1,
      endLine: sym.range.end.line + 1,
      endColumn: sym.range.end.character + 1,
      selectionLine: sym.selectionRange.start.line + 1,
      selectionColumn: sym.selectionRange.start.character + 1,
      parent,
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenSymbols(sym.children, sym.name));
    }
  }
  return result;
}

interface LspHandlerDeps {
  log: (message: string) => void;
}

export function createLspHandlers(
  deps: LspHandlerDeps,
): Record<string, RequestHandler> {
  async function handleGoToDefinition(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const line = requireNumber(params.line, "line") - 1;
    const column = requireNumber(params.column, "column") - 1;
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri); // Ensure document is loaded for language server
    const position = new vscode.Position(line, column);

    let locations: vscode.Location[] | vscode.LocationLink[] | undefined;
    try {
      locations = await vscode.commands.executeCommand<
        vscode.Location[] | vscode.LocationLink[]
      >("vscode.executeDefinitionProvider", uri, position);
    } catch (err: unknown) {
      return null;
    }

    if (!locations || locations.length === 0) return null;

    return locations.map((loc) => {
      if ("targetUri" in loc) {
        return {
          file: loc.targetUri.fsPath,
          line: loc.targetRange.start.line + 1,
          column: loc.targetRange.start.character + 1,
          endLine: loc.targetRange.end.line + 1,
          endColumn: loc.targetRange.end.character + 1,
        };
      }
      return {
        file: loc.uri.fsPath,
        line: loc.range.start.line + 1,
        column: loc.range.start.character + 1,
        endLine: loc.range.end.line + 1,
        endColumn: loc.range.end.character + 1,
      };
    });
  }

  async function handleFindReferences(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const line = requireNumber(params.line, "line") - 1;
    const column = requireNumber(params.column, "column") - 1;
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(line, column);

    let locations: vscode.Location[] | undefined;
    try {
      locations = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        position,
      );
    } catch (err: unknown) {
      return { references: [] };
    }

    if (!locations || locations.length === 0) return { references: [] };

    return {
      references: locations.map((loc) => ({
        file: loc.uri.fsPath,
        line: loc.range.start.line + 1,
        column: loc.range.start.character + 1,
        endLine: loc.range.end.line + 1,
        endColumn: loc.range.end.character + 1,
      })),
      count: locations.length,
    };
  }

  async function handleGetHover(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const line = requireNumber(params.line, "line") - 1;
    const column = requireNumber(params.column, "column") - 1;
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(line, column);

    let hovers: vscode.Hover[] | undefined;
    try {
      hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        position,
      );
    } catch (err: unknown) {
      return null;
    }

    if (!hovers || hovers.length === 0) return null;

    const contents: string[] = [];
    for (const hover of hovers) {
      for (const content of hover.contents) {
        if (typeof content === "string") {
          contents.push(content);
        } else if ("value" in content) {
          contents.push(content.value);
        }
      }
    }

    return {
      contents,
      range: hovers[0]?.range
        ? {
            startLine: hovers[0].range.start.line + 1,
            startColumn: hovers[0].range.start.character + 1,
            endLine: hovers[0].range.end.line + 1,
            endColumn: hovers[0].range.end.character + 1,
          }
        : null,
    };
  }

  async function handleGetCodeActions(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const startLine = requireNumber(params.startLine, "startLine") - 1;
    const startColumn = requireNumber(params.startColumn, "startColumn") - 1;
    const endLine = requireNumber(params.endLine, "endLine") - 1;
    const endColumn = requireNumber(params.endColumn, "endColumn") - 1;
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(startLine, startColumn, endLine, endColumn);

    let actions: vscode.CodeAction[] | undefined;
    try {
      actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        uri,
        range,
      );
    } catch (err: unknown) {
      return { actions: [] };
    }

    if (!actions || actions.length === 0) return { actions: [] };

    return {
      actions: actions.map((a) => ({
        title: a.title,
        kind: a.kind?.value,
        isPreferred: a.isPreferred ?? false,
      })),
    };
  }

  async function handleApplyCodeAction(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const startLine = requireNumber(params.startLine, "startLine") - 1;
    const startColumn = requireNumber(params.startColumn, "startColumn") - 1;
    const endLine = requireNumber(params.endLine, "endLine") - 1;
    const endColumn = requireNumber(params.endColumn, "endColumn") - 1;
    const actionTitle = requireString(params.actionTitle, "actionTitle");
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(startLine, startColumn, endLine, endColumn);

    let actions: vscode.CodeAction[] | undefined;
    try {
      actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        uri,
        range,
      );
    } catch (err: unknown) {
      return {
        applied: false,
        error: err instanceof Error ? err.message : "Command failed",
      };
    }

    if (!actions || actions.length === 0) {
      return {
        applied: false,
        error: "No code actions available at this range",
      };
    }

    const action = actions.find((a) => a.title === actionTitle);
    if (!action) {
      return {
        applied: false,
        error: `Code action "${actionTitle}" not found`,
        available: actions.map((a) => a.title),
      };
    }

    if (action.edit) {
      const applied = await vscode.workspace.applyEdit(action.edit);
      if (!applied) {
        return { applied: false, error: "Failed to apply workspace edit" };
      }
    }

    if (action.command) {
      deps.log(`Executing code action command: ${action.command.command}`);
      try {
        await vscode.commands.executeCommand(
          action.command.command,
          ...(action.command.arguments ?? []),
        );
      } catch (err: unknown) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : "Command failed",
        };
      }
    }

    return {
      applied: true,
      title: actionTitle,
      command: action.command?.command ?? null,
    };
  }

  async function handleRenameSymbol(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const line = requireNumber(params.line, "line") - 1;
    const column = requireNumber(params.column, "column") - 1;
    const newName = requireString(params.newName, "newName");
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(line, column);

    let edit: vscode.WorkspaceEdit | undefined;
    try {
      edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider",
        uri,
        position,
        newName,
      );
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Command failed",
      };
    }

    if (!edit) {
      return { success: false, error: "Rename not supported at this position" };
    }

    const affectedFiles: Array<{ file: string; editCount: number }> = [];
    for (const [entryUri, edits] of edit.entries()) {
      affectedFiles.push({ file: entryUri.fsPath, editCount: edits.length });
    }

    if (affectedFiles.length === 0) {
      return { success: false, error: "No edits generated by rename" };
    }

    const applied = await vscode.workspace.applyEdit(edit);
    return {
      success: applied,
      newName,
      affectedFiles,
      totalEdits: affectedFiles.reduce((s, f) => s + f.editCount, 0),
    };
  }

  async function handleSearchSymbols(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const query = requireString(params.query, "query");
    const maxResults = Math.min(
      typeof params.maxResults === "number" ? params.maxResults : 50,
      200,
    );

    let symbols: vscode.SymbolInformation[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<
        vscode.SymbolInformation[]
      >("vscode.executeWorkspaceSymbolProvider", query);
    } catch (err: unknown) {
      return { symbols: [], count: 0 };
    }

    if (!symbols || symbols.length === 0) return { symbols: [], count: 0 };

    const limited = symbols.slice(0, maxResults);
    return {
      symbols: limited.map((s) => ({
        name: s.name,
        kind: vscode.SymbolKind[s.kind],
        file: s.location.uri.fsPath,
        line: s.location.range.start.line + 1,
        column: s.location.range.start.character + 1,
        containerName: s.containerName || null,
      })),
      count: symbols.length,
      truncated: symbols.length > maxResults,
    };
  }

  async function handleGetDocumentSymbols(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);

    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      );
    } catch (err: unknown) {
      return { symbols: [], count: 0 };
    }

    if (!symbols || symbols.length === 0) return { symbols: [], count: 0 };

    const flat = flattenSymbols(symbols, null);
    return { symbols: flat, count: flat.length };
  }

  async function handleGetCallHierarchy(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const file = requireString(params.file, "file");
    const line = requireNumber(params.line, "line") - 1;
    const column = requireNumber(params.column, "column") - 1;
    const direction =
      typeof params.direction === "string" ? params.direction : "both";
    const maxResults =
      typeof params.maxResults === "number"
        ? Math.min(params.maxResults, 200)
        : 50;

    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(line, column);

    let items: vscode.CallHierarchyItem[] | undefined;
    try {
      items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        "vscode.prepareCallHierarchy",
        uri,
        position,
      );
    } catch (err: unknown) {
      return null;
    }

    if (!items || items.length === 0) return null;

    const item = items[0];
    const symbol = {
      name: item.name,
      kind: vscode.SymbolKind[item.kind],
      detail: item.detail || null,
      file: item.uri.fsPath,
      line: item.selectionRange.start.line + 1,
      column: item.selectionRange.start.character + 1,
    };

    let incoming: unknown[] | null = null;
    let outgoing: unknown[] | null = null;

    if (direction === "incoming" || direction === "both") {
      let calls: vscode.CallHierarchyIncomingCall[] | undefined;
      try {
        calls = await vscode.commands.executeCommand<
          vscode.CallHierarchyIncomingCall[]
        >("vscode.provideIncomingCalls", item);
      } catch {
        calls = undefined;
      }
      incoming = calls
        ? calls.slice(0, maxResults).map((c) => ({
            name: c.from.name,
            kind: vscode.SymbolKind[c.from.kind],
            detail: c.from.detail || null,
            file: c.from.uri.fsPath,
            line: c.from.selectionRange.start.line + 1,
            column: c.from.selectionRange.start.character + 1,
            callSites: c.fromRanges.map((r) => ({
              line: r.start.line + 1,
              column: r.start.character + 1,
            })),
          }))
        : [];
    }

    if (direction === "outgoing" || direction === "both") {
      let calls: vscode.CallHierarchyOutgoingCall[] | undefined;
      try {
        calls = await vscode.commands.executeCommand<
          vscode.CallHierarchyOutgoingCall[]
        >("vscode.provideOutgoingCalls", item);
      } catch {
        calls = undefined;
      }
      outgoing = calls
        ? calls.slice(0, maxResults).map((c) => ({
            name: c.to.name,
            kind: vscode.SymbolKind[c.to.kind],
            detail: c.to.detail || null,
            file: c.to.uri.fsPath,
            line: c.to.selectionRange.start.line + 1,
            column: c.to.selectionRange.start.character + 1,
            callSites: c.fromRanges.map((r) => ({
              line: r.start.line + 1,
              column: r.start.character + 1,
            })),
          }))
        : [];
    }

    return {
      symbol,
      ...(incoming !== null && { incoming }),
      ...(outgoing !== null && { outgoing }),
    };
  }

  return {
    "extension/goToDefinition": handleGoToDefinition,
    "extension/findReferences": handleFindReferences,
    "extension/getHover": handleGetHover,
    "extension/getCodeActions": handleGetCodeActions,
    "extension/applyCodeAction": handleApplyCodeAction,
    "extension/renameSymbol": handleRenameSymbol,
    "extension/searchSymbols": handleSearchSymbols,
    "extension/getDocumentSymbols": handleGetDocumentSymbols,
    "extension/getCallHierarchy": handleGetCallHierarchy,
  };
}
