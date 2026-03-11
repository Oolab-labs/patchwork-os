import * as vscode from "vscode";
import { MAX_HINTS } from "../constants";

export async function handleGetInlayHints(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = params.file;
  const startLine = params.startLine;
  const endLine = params.endLine;

  if (typeof file !== "string") throw new Error("file is required");
  if (typeof startLine !== "number") throw new Error("startLine is required");
  if (typeof endLine !== "number") throw new Error("endLine is required");

  const uri = vscode.Uri.file(file);

  // Ensure document is open so the language server has it loaded
  await vscode.workspace.openTextDocument(uri);

  const range = new vscode.Range(
    new vscode.Position(Math.max(0, startLine - 1), 0),
    new vscode.Position(Math.max(0, endLine - 1), Number.MAX_SAFE_INTEGER),
  );

  let hints: vscode.InlayHint[] | undefined;
  try {
    hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      "vscode.executeInlayHintProvider",
      uri,
      range,
    );
  } catch {
    return {
      hints: [],
      count: 0,
      message: "Inlay hint provider unavailable for this file type",
    };
  }

  if (!hints || hints.length === 0) {
    return { hints: [], count: 0 };
  }

  const capped = hints.slice(0, MAX_HINTS);
  const serialized = capped.map((h) => {
    const label =
      typeof h.label === "string"
        ? h.label
        : h.label.map((part) => part.value).join("");
    return {
      position: { line: h.position.line + 1, column: h.position.character + 1 },
      label,
      kind:
        h.kind === vscode.InlayHintKind.Type
          ? "type"
          : h.kind === vscode.InlayHintKind.Parameter
            ? "parameter"
            : "other",
      tooltip: typeof h.tooltip === "string" ? h.tooltip : undefined,
    };
  });

  return {
    hints: serialized,
    count: hints.length,
    capped: hints.length > MAX_HINTS,
  };
}
