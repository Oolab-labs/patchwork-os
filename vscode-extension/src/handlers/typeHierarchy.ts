import * as vscode from "vscode";

export async function handleGetTypeHierarchy(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = params.file;
  const line = params.line;
  const column = params.column;

  if (typeof file !== "string") throw new Error("file is required");
  if (typeof line !== "number") throw new Error("line is required");
  if (typeof column !== "number") throw new Error("column is required");

  const direction =
    typeof params.direction === "string" ? params.direction : "both";
  const maxResults =
    typeof params.maxResults === "number" ? params.maxResults : 20;

  const uri = vscode.Uri.file(file);
  const position = new vscode.Position(line - 1, column - 1);

  let items: vscode.TypeHierarchyItem[] | undefined;
  try {
    items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
      "vscode.prepareTypeHierarchy",
      uri,
      position,
    );
  } catch {
    return { found: false, message: "Type hierarchy provider unavailable" };
  }

  if (!items || items.length === 0) {
    return {
      found: false,
      message: "No type hierarchy found at this position",
    };
  }

  const rootItem = items[0];

  function serializeItem(item: vscode.TypeHierarchyItem) {
    return {
      name: item.name,
      kind: vscode.SymbolKind[item.kind],
      file: item.uri.fsPath,
      line: item.selectionRange.start.line + 1,
      column: item.selectionRange.start.character + 1,
    };
  }

  let supertypes: ReturnType<typeof serializeItem>[] = [];
  let subtypes: ReturnType<typeof serializeItem>[] = [];

  if (direction === "supertypes" || direction === "both") {
    try {
      const parents = await vscode.commands.executeCommand<
        vscode.TypeHierarchyItem[]
      >("vscode.provideSupertypes", rootItem);
      if (parents) {
        supertypes = parents.slice(0, maxResults).map(serializeItem);
      }
    } catch {
      // Provider may not support supertypes
    }
  }

  if (direction === "subtypes" || direction === "both") {
    try {
      const children = await vscode.commands.executeCommand<
        vscode.TypeHierarchyItem[]
      >("vscode.provideSubtypes", rootItem);
      if (children) {
        subtypes = children.slice(0, maxResults).map(serializeItem);
      }
    } catch {
      // Provider may not support subtypes
    }
  }

  return {
    found: true,
    root: serializeItem(rootItem),
    supertypes,
    subtypes,
    direction,
  };
}
