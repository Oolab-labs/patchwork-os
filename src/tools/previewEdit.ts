import fs from "node:fs";
import {
  error,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

/**
 * Compute a simple unified diff between two arrays of lines.
 * Returns unified diff lines (with +/- prefixes and @@ headers).
 */
export function computeUnifiedDiff(
  originalLines: string[],
  newLines: string[],
  filePath: string,
  contextLines = 3,
): { diff: string; linesAdded: number; linesRemoved: number } {
  // Simple Myers-like LCS diff via dynamic programming
  type Op = { type: "equal" | "delete" | "insert"; line: string };
  const ops: Op[] = [];

  const m = originalLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (originalLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      }
    }
  }

  // Trace back through LCS
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && originalLines[i] === newLines[j]) {
      ops.push({ type: "equal", line: originalLines[i]! });
      i++;
      j++;
    } else if (
      j < n &&
      (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))
    ) {
      ops.push({ type: "insert", line: newLines[j]! });
      j++;
    } else {
      ops.push({ type: "delete", line: originalLines[i]! });
      i++;
    }
  }

  // Count changes
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const op of ops) {
    if (op.type === "insert") linesAdded++;
    else if (op.type === "delete") linesRemoved++;
  }

  if (linesAdded === 0 && linesRemoved === 0) {
    return { diff: "", linesAdded: 0, linesRemoved: 0 };
  }

  // Build unified diff with context
  const diffLines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // Group ops into hunks with context
  const changeIndices: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type !== "equal") changeIndices.push(k);
  }

  const hunks: Array<[number, number]> = [];
  if (changeIndices.length > 0) {
    let hunkStart = Math.max(0, changeIndices[0]! - contextLines);
    let hunkEnd = Math.min(ops.length - 1, changeIndices[0]! + contextLines);

    for (let k = 1; k < changeIndices.length; k++) {
      const gapStart = changeIndices[k - 1]! + contextLines + 1;
      const gapEnd = changeIndices[k]! - contextLines - 1;
      if (gapStart <= gapEnd) {
        hunks.push([hunkStart, hunkEnd]);
        hunkStart = Math.max(0, changeIndices[k]! - contextLines);
      }
      hunkEnd = Math.min(ops.length - 1, changeIndices[k]! + contextLines);
    }
    hunks.push([hunkStart, hunkEnd]);
  }

  // Render hunks
  for (const [hStart, hEnd] of hunks) {
    const hunkOps = ops.slice(hStart, hEnd + 1);

    // Compute original and new line numbers
    let origLine = 1;
    let newLine = 1;
    // Count ops before hStart to get starting line numbers
    for (let k = 0; k < hStart; k++) {
      const op = ops[k]!;
      if (op.type === "equal" || op.type === "delete") origLine++;
      if (op.type === "equal" || op.type === "insert") newLine++;
    }

    const origCount = hunkOps.filter(
      (o) => o.type === "equal" || o.type === "delete",
    ).length;
    const newCount = hunkOps.filter(
      (o) => o.type === "equal" || o.type === "insert",
    ).length;

    diffLines.push(`@@ -${origLine},${origCount} +${newLine},${newCount} @@`);

    for (const op of hunkOps) {
      if (op.type === "equal") diffLines.push(` ${op.line}`);
      else if (op.type === "delete") diffLines.push(`-${op.line}`);
      else diffLines.push(`+${op.line}`);
    }
  }

  return {
    diff: diffLines.join("\n"),
    linesAdded,
    linesRemoved,
  };
}

/**
 * Apply a searchReplace operation to content and return the new content.
 */
export function applySearchReplace(
  content: string,
  search: string,
  replace: string,
  useRegex: boolean,
  caseSensitive = true,
): string {
  if (useRegex) {
    const flags = caseSensitive ? "g" : "gi";
    const re = new RegExp(search, flags);
    return content.replace(re, replace);
  }
  // Literal string replace all occurrences
  const parts = caseSensitive
    ? content.split(search)
    : content.split(new RegExp(escapeRegex(search), "gi"));
  return parts.join(replace);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply a lineRange replacement to content and return the new content.
 */
export function applyLineRange(
  content: string,
  startLine: number,
  endLine: number,
  newContent: string,
): string {
  const lines = content.split("\n");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const replacement = newContent.endsWith("\n")
    ? newContent.slice(0, -1).split("\n")
    : newContent.split("\n");
  return [...before, ...replacement, ...after].join("\n");
}

export function createPreviewEditTool(workspace: string) {
  return {
    schema: {
      name: "previewEdit",
      description:
        "Preview what editText or searchAndReplace would do as a unified diff, without writing to disk.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath", "operation"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace-relative or absolute path to the file",
          },
          operation: {
            type: "string" as const,
            enum: ["lineRange", "searchReplace"] as const,
            description: "Type of edit to preview",
          },
          startLine: {
            type: "integer" as const,
            description: "Start line (1-based, lineRange only)",
          },
          endLine: {
            type: "integer" as const,
            description: "End line inclusive (1-based, lineRange only)",
          },
          newContent: {
            type: "string" as const,
            description: "Replacement content for the line range",
          },
          search: {
            type: "string" as const,
            description: "Pattern to search for (searchReplace only)",
          },
          replace: {
            type: "string" as const,
            description: "Replacement text (searchReplace only)",
          },
          useRegex: {
            type: "boolean" as const,
            description:
              "Treat search as a regex (searchReplace only, default false)",
          },
          caseSensitive: {
            type: "boolean" as const,
            description:
              "Case-sensitive search (searchReplace only, default true)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          diff: { type: "string" as const },
          linesAdded: { type: "integer" as const },
          linesRemoved: { type: "integer" as const },
          preview: {
            type: "array" as const,
            items: { type: "string" as const },
          },
          unchanged: { type: "boolean" as const },
        },
        required: ["diff", "linesAdded", "linesRemoved", "preview"],
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const operation = requireString(args, "operation");

      if (operation !== "lineRange" && operation !== "searchReplace") {
        return error('operation must be "lineRange" or "searchReplace"');
      }

      let resolved: string;
      try {
        resolved = resolveFilePath(rawPath, workspace);
      } catch (e) {
        return error(
          `Invalid path: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      let originalContent: string;
      try {
        originalContent = await fs.promises.readFile(resolved, "utf-8");
      } catch {
        return error(`File not found: ${resolved}`);
      }

      let newContent: string;

      if (operation === "lineRange") {
        const startLine = optionalInt(args, "startLine", 1) ?? 1;
        const rawEnd = args.endLine;
        const totalLines = originalContent.split("\n").length;
        const endLine = typeof rawEnd === "number" ? rawEnd : totalLines;
        const replacement = optionalString(args, "newContent") ?? "";

        if (startLine > endLine) {
          return error("startLine must be <= endLine");
        }
        if (startLine < 1) {
          return error("startLine must be >= 1");
        }

        newContent = applyLineRange(
          originalContent,
          startLine,
          endLine,
          replacement,
        );
      } else {
        const search = optionalString(args, "search") ?? "";
        const replace = optionalString(args, "replace") ?? "";
        const useRegex = optionalBool(args, "useRegex") ?? false;
        const caseSensitive = optionalBool(args, "caseSensitive") ?? true;

        if (!search) {
          return error("search must not be empty for searchReplace operation");
        }

        try {
          newContent = applySearchReplace(
            originalContent,
            search,
            replace,
            useRegex,
            caseSensitive,
          );
        } catch (e) {
          return error(
            `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const originalLines = originalContent.split("\n");
      const newLines = newContent.split("\n");

      const relativePath = rawPath.startsWith("/")
        ? rawPath.slice(workspace.length + 1)
        : rawPath;

      const { diff, linesAdded, linesRemoved } = computeUnifiedDiff(
        originalLines,
        newLines,
        relativePath,
      );

      return successStructured({
        diff,
        linesAdded,
        linesRemoved,
        preview: newLines,
        unchanged: linesAdded === 0 && linesRemoved === 0,
      });
    },
  };
}
