import * as vscode from "vscode";

const MAX_SEMANTIC_TOKENS = 2000;
const MAX_LEGEND_ENTRIES = 50;
const MAX_TOKEN_NAME_LENGTH = 64;

function sanitizeName(s: string): string {
  return s.slice(0, MAX_TOKEN_NAME_LENGTH).replace(/[\x00-\x1f]/g, "");
}

export async function handleGetSemanticTokens(
  params: Record<string, unknown>,
): Promise<unknown> {
  const file = params.file;
  if (typeof file !== "string") throw new Error("file is required");

  const startLine =
    typeof params.startLine === "number" ? params.startLine : undefined;
  const endLine =
    typeof params.endLine === "number" ? params.endLine : undefined;
  const maxTokens =
    typeof params.maxTokens === "number"
      ? Math.min(Math.max(1, params.maxTokens), 5000)
      : MAX_SEMANTIC_TOKENS;

  const uri = vscode.Uri.file(file);

  // Fetch the legend (maps indices → readable names)
  let legend: vscode.SemanticTokensLegend | undefined;
  try {
    legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
      "vscode.provideDocumentSemanticTokensLegend",
      uri,
    );
  } catch {
    // Legend unavailable — provider not registered for this file type
  }

  if (!legend) {
    return {
      tokens: [],
      count: 0,
      capped: false,
      legend: { tokenTypes: [], tokenModifiers: [] },
      message: "Semantic tokens provider unavailable for this file type",
    };
  }

  // Sanitize legend entries (prevent oversized payloads / prompt injection)
  const tokenTypes = legend.tokenTypes
    .slice(0, MAX_LEGEND_ENTRIES)
    .map(sanitizeName);
  const tokenModifiers = legend.tokenModifiers
    .slice(0, MAX_LEGEND_ENTRIES)
    .map(sanitizeName);

  // Fetch the encoded token data
  let semanticTokens: vscode.SemanticTokens | undefined;
  try {
    semanticTokens =
      await vscode.commands.executeCommand<vscode.SemanticTokens>(
        "vscode.provideDocumentSemanticTokens",
        uri,
      );
  } catch {
    return {
      tokens: [],
      count: 0,
      capped: false,
      legend: { tokenTypes, tokenModifiers },
      message: "Failed to retrieve semantic tokens",
    };
  }

  if (!semanticTokens?.data || semanticTokens.data.length === 0) {
    return {
      tokens: [],
      count: 0,
      capped: false,
      legend: { tokenTypes, tokenModifiers },
    };
  }

  const data = semanticTokens.data;
  const totalTokens = Math.floor(data.length / 5);

  // Decode delta-encoded token stream.
  // Each group of 5 uint32 values: [deltaLine, deltaStartChar, length, typeIndex, modifiersBitmask]
  // deltaLine: lines moved since previous token (0 = same line)
  // deltaStartChar: if deltaLine > 0, absolute char on new line; else delta from previous char
  const decoded: Array<{
    line: number;
    column: number;
    length: number;
    type: string;
    modifiers: string[];
  }> = [];

  let absLine = 0; // 0-based running position
  let absChar = 0; // 0-based running position

  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0;
    const deltaStartChar = data[i + 1] ?? 0;
    const length = data[i + 2] ?? 0;
    const tokenTypeIndex = data[i + 3] ?? 0;
    const tokenModifiersBitmask = data[i + 4] ?? 0;

    if (deltaLine > 0) {
      absLine += deltaLine;
      absChar = deltaStartChar;
    } else {
      absChar += deltaStartChar;
    }

    // Convert to 1-based for output
    const outLine = absLine + 1;
    const outCol = absChar + 1;

    // Apply optional line range filter (1-based)
    if (startLine !== undefined && outLine < startLine) continue;
    if (endLine !== undefined && outLine > endLine) break;

    const type = tokenTypes[tokenTypeIndex] ?? `unknown_${tokenTypeIndex}`;

    const modifiers: string[] = [];
    for (let bit = 0; bit < tokenModifiers.length; bit++) {
      if (tokenModifiersBitmask & (1 << bit)) {
        const mod = tokenModifiers[bit];
        if (mod !== undefined) modifiers.push(mod);
      }
    }

    decoded.push({ line: outLine, column: outCol, length, type, modifiers });

    if (decoded.length >= maxTokens) break;
  }

  return {
    tokens: decoded,
    count: decoded.length,
    capped: decoded.length < totalTokens,
    legend: { tokenTypes, tokenModifiers },
  };
}
