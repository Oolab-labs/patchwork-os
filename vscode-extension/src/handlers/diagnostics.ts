import * as vscode from "vscode";
import { MAX_ALL_DIAGNOSTICS } from "../constants";

const SEVERITY_MAP: Record<number, string> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "information",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

export function diagnosticToJson(d: vscode.Diagnostic) {
  return {
    message: d.message,
    severity: SEVERITY_MAP[d.severity] ?? "error",
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source ?? "",
    code:
      typeof d.code === "object" ? (d.code as { value: unknown }).value : d.code,
  };
}

export async function handleGetDiagnostics(
  params: Record<string, unknown>,
): Promise<unknown> {
  const fileUri = params.file as string | undefined;
  if (fileUri) {
    const uri = vscode.Uri.parse(
      fileUri.startsWith("file://") ? fileUri : `file://${fileUri}`,
    );
    const diags = vscode.languages.getDiagnostics(uri);
    return diags.map(diagnosticToJson);
  }
  // Return all diagnostics (capped to prevent oversized payloads)
  const allDiags = vscode.languages.getDiagnostics();
  const result: Array<{ file: string; diagnostics: unknown[] }> = [];
  let totalCount = 0;
  for (const [uri, diags] of allDiags) {
    if (diags.length > 0) {
      const capped = diags.slice(0, MAX_ALL_DIAGNOSTICS - totalCount);
      result.push({
        file: uri.fsPath,
        diagnostics: capped.map(diagnosticToJson),
      });
      totalCount += capped.length;
      if (totalCount >= MAX_ALL_DIAGNOSTICS) break;
    }
  }
  return result;
}
