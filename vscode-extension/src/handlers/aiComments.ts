import * as vscode from "vscode";
import type { AICommentEntry } from "../types";

const SEVERITY_MAP: Record<string, string> = {
  fix: "fix",
  todo: "todo",
  question: "question",
  warn: "warn",
  task: "task",
};

const AI_COMMENT_PATTERNS: Array<{ regex: RegExp; syntax: string }> = [
  { regex: /\/\/\s*AI:\s*(.+)/, syntax: "//" },
  { regex: /#\s*AI:\s*(.+)/, syntax: "#" },
  { regex: /\/\*\s*AI:\s*(.*?)\s*\*\//, syntax: "/* */" },
  { regex: /<!--\s*AI:\s*(.*?)\s*-->/, syntax: "<!-- -->" },
  { regex: /--\s*AI:\s*(.+)/, syntax: "--" },
  { regex: /%%\s*AI:\s*(.+)/, syntax: "%%" },
  { regex: /'\s*AI:\s*(.+)/, syntax: "'" },
];

// Per-document cache to avoid re-scanning unchanged documents
const documentCache = new Map<string, AICommentEntry[]>();

function parseSeverity(commentText: string): {
  severity: string;
  text: string;
} {
  const match = commentText.match(/^(FIX|TODO|QUESTION|WARN|TASK)\s*:?\s*/i);
  if (match) {
    const key = match[1]?.toLowerCase() ?? "";
    return {
      severity: SEVERITY_MAP[key] ?? "task",
      text: commentText.slice(match[0].length).trim(),
    };
  }
  return { severity: "task", text: commentText };
}

export function scanDocumentForAIComments(
  doc: vscode.TextDocument,
): AICommentEntry[] {
  const results: AICommentEntry[] = [];
  const lineCount = doc.lineCount;
  for (let i = 0; i < lineCount; i++) {
    const lineText = doc.lineAt(i).text;
    for (const pattern of AI_COMMENT_PATTERNS) {
      const match = pattern.regex.exec(lineText);
      if (match?.[1]) {
        const rawComment = match[1].trim();
        const { severity, text } = parseSeverity(rawComment);
        results.push({
          file: doc.uri.fsPath,
          line: i + 1,
          comment: text,
          syntax: pattern.syntax,
          fullLine: lineText.trim(),
          severity,
        });
        break;
      }
    }
  }
  // Update the per-document cache
  documentCache.set(doc.uri.toString(), results);
  return results;
}

export function scanAllOpenDocuments(): AICommentEntry[] {
  const allComments: AICommentEntry[] = [];
  // Remove closed documents from cache
  const openUris = new Set<string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file") {
      openUris.add(doc.uri.toString());
      // Use cached results if available, otherwise scan
      const cached = documentCache.get(doc.uri.toString());
      if (cached) {
        allComments.push(...cached);
      } else {
        allComments.push(...scanDocumentForAIComments(doc));
      }
    }
  }
  // Prune cache entries for closed documents
  for (const key of documentCache.keys()) {
    if (!openUris.has(key)) {
      documentCache.delete(key);
    }
  }
  return allComments;
}

export function invalidateDocumentCache(uri: string): void {
  documentCache.delete(uri);
}

export async function handleGetAIComments(): Promise<unknown> {
  return scanAllOpenDocuments();
}
