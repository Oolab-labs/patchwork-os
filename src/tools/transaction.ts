import crypto from "node:crypto";
import fs from "node:fs";
import { applyLineRange, applySearchReplace } from "./previewEdit.js";
import {
  error,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

interface StagedEdit {
  filePath: string; // absolute resolved path
  originalContent: string;
  newContent: string;
}

interface Transaction {
  id: string;
  createdAt: number;
  edits: StagedEdit[];
}

/** Transactions older than this are automatically rolled back. */
export const TRANSACTION_TTL_MS = 30 * 60 * 1000;

// Module-scoped state — transactions die with process
const transactions = new Map<string, Transaction>();

function getTransaction(id: string): Transaction | undefined {
  return transactions.get(id);
}

/**
 * Roll back and remove all transactions whose `createdAt` is older than
 * `TRANSACTION_TTL_MS`. Exported for testing.
 */
export function _cleanupExpiredTransactions(): number {
  const now = Date.now();
  let count = 0;
  for (const [id, tx] of transactions) {
    if (now - tx.createdAt > TRANSACTION_TTL_MS) {
      console.warn(
        `[transaction] TTL expired — rolling back transaction "${id}" (age ${Math.round((now - tx.createdAt) / 1000)}s)`,
      );
      transactions.delete(id);
      count++;
    }
  }
  return count;
}

// Periodic cleanup — runs every 5 minutes; unref'd so it doesn't block exit.
const _ttlInterval = setInterval(_cleanupExpiredTransactions, 5 * 60 * 1000);
_ttlInterval.unref();

function resolveAndRead(
  rawPath: string,
  workspace: string,
): { resolved: string; content: string } {
  const resolved = resolveFilePath(rawPath, workspace, { write: true });
  const content = fs.readFileSync(resolved, "utf-8");
  return { resolved, content };
}

export function createTransactionTools(workspace: string) {
  const beginTransaction = {
    schema: {
      name: "beginTransaction",
      description:
        "Start a new multi-file edit transaction. Returns a transactionId for subsequent stageEdit calls.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          transactionId: {
            type: "string" as const,
            description: "Optional custom ID. Auto-generated if omitted.",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          transactionId: { type: "string" as const },
        },
        required: ["transactionId"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const customId = optionalString(args, "transactionId");
      const id = customId ?? crypto.randomUUID();

      if (transactions.has(id)) {
        return error(`Transaction "${id}" already exists`);
      }

      transactions.set(id, {
        id,
        createdAt: Date.now(),
        edits: [],
      });

      return successStructured({ transactionId: id });
    },
  };

  const stageEdit = {
    schema: {
      name: "stageEdit",
      description:
        "Stage a file edit inside a transaction. Supports lineRange and searchReplace operations (same params as previewEdit). Does NOT write to disk.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["transactionId", "filePath", "operation"],
        properties: {
          transactionId: {
            type: "string" as const,
            description: "Transaction ID from beginTransaction",
          },
          filePath: {
            type: "string" as const,
            description: "Workspace-relative or absolute path to the file",
          },
          operation: {
            type: "string" as const,
            enum: ["lineRange", "searchReplace"] as const,
            description: "Type of edit",
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
            description: "Treat search as regex (searchReplace only)",
          },
          caseSensitive: {
            type: "boolean" as const,
            description:
              "Case-sensitive match (searchReplace only, default true)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          staged: { type: "integer" as const },
          transactionId: { type: "string" as const },
          filePath: { type: "string" as const },
        },
        required: ["staged", "transactionId"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const txId = requireString(args, "transactionId");
      const rawPath = requireString(args, "filePath");
      const operation = requireString(args, "operation");

      const tx = getTransaction(txId);
      if (!tx) {
        return error(
          `Transaction "${txId}" not found. Call beginTransaction first.`,
        );
      }

      if (Date.now() - tx.createdAt > TRANSACTION_TTL_MS) {
        transactions.delete(txId);
        return error(
          `Transaction "${txId}" expired (TTL ${TRANSACTION_TTL_MS / 60000}min)`,
        );
      }

      if (operation !== "lineRange" && operation !== "searchReplace") {
        return error('operation must be "lineRange" or "searchReplace"');
      }

      let resolved: string;
      let originalContent: string;
      try {
        ({ resolved, content: originalContent } = resolveAndRead(
          rawPath,
          workspace,
        ));
      } catch (e) {
        return error(
          `Cannot read file: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      let newContent: string;

      if (operation === "lineRange") {
        const startLine = optionalInt(args, "startLine", 1) ?? 1;
        const totalLines = originalContent.split("\n").length;
        const rawEnd = args.endLine;
        const endLine = typeof rawEnd === "number" ? rawEnd : totalLines;
        const replacement = optionalString(args, "newContent") ?? "";

        if (startLine > endLine) {
          return error("startLine must be <= endLine");
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
          return error("search must not be empty for searchReplace");
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

      tx.edits.push({ filePath: resolved, originalContent, newContent });
      return successStructured({
        staged: tx.edits.length,
        transactionId: txId,
        filePath: rawPath,
      });
    },
  };

  const commitTransaction = {
    schema: {
      name: "commitTransaction",
      description:
        "Write all staged edits atomically. All files are written; on partial failure, written files are NOT rolled back (use rollbackTransaction before commitTransaction to verify).",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["transactionId"],
        properties: {
          transactionId: {
            type: "string" as const,
            description: "Transaction ID from beginTransaction",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          committed: { type: "integer" as const },
          files: {
            type: "array" as const,
            items: { type: "string" as const },
          },
          errors: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                file: { type: "string" as const },
                error: { type: "string" as const },
              },
              required: ["file", "error"],
            },
          },
        },
        required: ["committed", "files"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const txId = requireString(args, "transactionId");
      const tx = getTransaction(txId);
      if (!tx) {
        return error(`Transaction "${txId}" not found`);
      }

      if (Date.now() - tx.createdAt > TRANSACTION_TTL_MS) {
        transactions.delete(txId);
        return error(
          `Transaction "${txId}" expired (TTL ${TRANSACTION_TTL_MS / 60000}min)`,
        );
      }

      const written: string[] = [];
      const errors: Array<{ file: string; error: string }> = [];

      for (const edit of tx.edits) {
        try {
          await fs.promises.writeFile(edit.filePath, edit.newContent, "utf-8");
          written.push(edit.filePath);
        } catch (e) {
          errors.push({
            file: edit.filePath,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      transactions.delete(txId);

      return successStructured({
        committed: written.length,
        files: written,
        ...(errors.length > 0 && { errors }),
      });
    },
  };

  const rollbackTransaction = {
    schema: {
      name: "rollbackTransaction",
      description:
        "Discard all staged edits for a transaction without writing anything to disk.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["transactionId"],
        properties: {
          transactionId: {
            type: "string" as const,
            description: "Transaction ID from beginTransaction",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          rolledBack: { type: "integer" as const },
          transactionId: { type: "string" as const },
        },
        required: ["rolledBack", "transactionId"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const txId = requireString(args, "transactionId");
      const tx = getTransaction(txId);
      if (!tx) {
        return error(`Transaction "${txId}" not found`);
      }

      const count = tx.edits.length;
      transactions.delete(txId);

      return successStructured({ rolledBack: count, transactionId: txId });
    },
  };

  return {
    beginTransaction,
    stageEdit,
    commitTransaction,
    rollbackTransaction,
  };
}
