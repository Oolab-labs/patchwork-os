/**
 * Typed wrappers around HeadlessLspClient for the three tools that fall back
 * to typescript-language-server when the VS Code extension is not connected:
 *   - goToDefinition  → textDocument/definition
 *   - findReferences  → textDocument/references
 *   - getTypeSignature → textDocument/hover
 */
import fs from "node:fs";
import { getHeadlessLspClient } from "./lspClient.js";

export interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Convert an absolute file path to an LSP file URI. */
function toUri(filePath: string): string {
  return `file://${filePath}`;
}

/** Detect language ID from file extension. */
function languageIdFromPath(filePath: string): string {
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".mts") ||
    filePath.endsWith(".cts")
  )
    return "typescript";
  if (filePath.endsWith(".tsx")) return "typescriptreact";
  if (
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  )
    return "javascript";
  if (filePath.endsWith(".jsx")) return "javascriptreact";
  return "typescript";
}

/** Ensure a file is open in the LSP server and the client is initialized. */
async function ensureFile(
  filePath: string,
  workspaceRoot: string,
): Promise<void> {
  const client = getHeadlessLspClient();
  if (!client.isReady) {
    await client.initialize(workspaceRoot);
  }
  const uri = toUri(filePath);
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    // Let the LSP server handle missing files
  }
  await client.openFile(uri, languageIdFromPath(filePath), text);
}

/**
 * textDocument/definition
 * line and character are 1-based (bridge convention), converted to 0-based for LSP.
 */
export async function lspDefinition(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string,
): Promise<LspLocation[]> {
  await ensureFile(filePath, workspaceRoot);
  const client = getHeadlessLspClient();
  const raw = await client.request("textDocument/definition", {
    textDocument: { uri: toUri(filePath) },
    position: { line: line - 1, character: character - 1 },
  });

  if (!raw) return [];
  const locs = Array.isArray(raw) ? raw : [raw];
  return locs.filter(
    (l): l is LspLocation =>
      l !== null &&
      typeof l === "object" &&
      typeof (l as LspLocation).uri === "string",
  );
}

/**
 * textDocument/references
 * line and character are 1-based, converted to 0-based for LSP.
 */
export async function lspReferences(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string,
): Promise<LspLocation[]> {
  await ensureFile(filePath, workspaceRoot);
  const client = getHeadlessLspClient();
  const raw = await client.request("textDocument/references", {
    textDocument: { uri: toUri(filePath) },
    position: { line: line - 1, character: character - 1 },
    context: { includeDeclaration: true },
  });

  if (!raw || !Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is LspLocation =>
      l !== null &&
      typeof l === "object" &&
      typeof (l as LspLocation).uri === "string",
  );
}

/**
 * textDocument/hover → returns extracted markdown/text string, or null.
 * line and character are 1-based, converted to 0-based for LSP.
 */
export async function lspHover(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string,
): Promise<string | null> {
  await ensureFile(filePath, workspaceRoot);
  const client = getHeadlessLspClient();
  const raw = await client.request("textDocument/hover", {
    textDocument: { uri: toUri(filePath) },
    position: { line: line - 1, character: character - 1 },
  });

  if (!raw) return null;
  const hover = raw as Record<string, unknown>;

  // LSP hover contents can be: string | { language, value } | { kind, value } | array
  const contents = hover.contents;
  if (!contents) return null;

  if (typeof contents === "string") return contents;

  if (typeof contents === "object" && !Array.isArray(contents)) {
    const obj = contents as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
  }

  if (Array.isArray(contents)) {
    const parts: string[] = [];
    for (const c of contents) {
      if (typeof c === "string") parts.push(c);
      else if (
        c &&
        typeof c === "object" &&
        typeof (c as Record<string, unknown>).value === "string"
      ) {
        parts.push((c as Record<string, unknown>).value as string);
      }
    }
    return parts.join("\n\n") || null;
  }

  return null;
}
