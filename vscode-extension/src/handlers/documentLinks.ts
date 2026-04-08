import * as vscode from "vscode";

const MAX_LINKS = 100;
const LINK_RESOLVE_COUNT = 100;

// URL schemes that are safe to return as-is
const SAFE_SCHEMES = new Set(["file", "vscode", "vscode-insiders"]);

// Private/internal hostname patterns to redact
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|::1|0\.0\.0\.0)/i;

function sanitizeTarget(
  target: vscode.Uri | undefined,
  workspace: string,
): string | null {
  if (!target) return null;

  const scheme = target.scheme.toLowerCase();

  if (scheme === "file") {
    // Only return file:// links within the workspace
    const fsPath = target.fsPath;
    if (!fsPath.startsWith(workspace)) return null;
    return fsPath;
  }

  if (SAFE_SCHEMES.has(scheme)) {
    return target.toString();
  }

  // http/https — redact private/internal hosts
  if (scheme === "http" || scheme === "https") {
    const host = target.authority.split(":")[0] ?? "";
    if (PRIVATE_HOST_RE.test(host)) return null;
    return target.toString();
  }

  // Anything else (data:, ftp:, etc.) — omit
  return null;
}

export async function handleGetDocumentLinks(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = params.file;
  if (typeof file !== "string") throw new Error("file is required");

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const uri = vscode.Uri.file(file);

  let links: vscode.DocumentLink[] | undefined;
  try {
    links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
      "vscode.executeLinkProvider",
      uri,
      LINK_RESOLVE_COUNT,
    );
  } catch {
    return {
      links: [],
      count: 0,
      message: "Document link provider unavailable",
    };
  }

  if (!links || links.length === 0) {
    return { links: [], count: 0 };
  }

  const serialized: Array<{
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    target: string | null;
  }> = [];

  for (const link of links.slice(0, MAX_LINKS)) {
    const target = sanitizeTarget(link.target, workspace);
    serialized.push({
      line: link.range.start.line + 1,
      column: link.range.start.character + 1,
      endLine: link.range.end.line + 1,
      endColumn: link.range.end.character + 1,
      target,
    });
  }

  return { links: serialized, count: serialized.length };
}
