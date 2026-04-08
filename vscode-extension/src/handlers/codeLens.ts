import * as vscode from "vscode";

const MAX_COMMAND_TITLE_LENGTH = 200;
const ITEM_RESOLVE_COUNT = 100;

export async function handleGetCodeLens(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = params.file;
  if (typeof file !== "string") throw new Error("file is required");

  const uri = vscode.Uri.file(file);

  let lenses: vscode.CodeLens[] | undefined;
  try {
    lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
      ITEM_RESOLVE_COUNT,
    );
  } catch {
    return {
      lenses: [],
      count: 0,
      message: "Code lens provider unavailable for this file type",
    };
  }

  if (!lenses || lenses.length === 0) {
    return { lenses: [], count: 0 };
  }

  const serialized = lenses.map((lens) => {
    // Truncate command title to prevent prompt injection via language server output
    const rawTitle = lens.command?.title ?? null;
    const command =
      rawTitle !== null
        ? rawTitle
            .slice(0, MAX_COMMAND_TITLE_LENGTH)
            .replace(/[\x00-\x1f]/g, "")
        : null;
    return {
      line: lens.range.start.line + 1,
      column: lens.range.start.character + 1,
      endLine: lens.range.end.line + 1,
      endColumn: lens.range.end.character + 1,
      command,
      // commandId intentionally omitted — leaks installed extension info
    };
  });

  return { lenses: serialized, count: serialized.length };
}
