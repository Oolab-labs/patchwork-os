import crypto from "node:crypto";
import fs from "node:fs";
import type { FileLock } from "../fileLock.js";
import { writeFileAtomic } from "../writeFileAtomic.js";
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
  /**
   * mtimeMs of the file at stage time. Used for optimistic-concurrency
   * detection at commit — if the file's mtime changed since staging, an
   * intervening edit (editText/replaceBlock/external) happened and we refuse
   * to clobber it. `undefined` when the file could not be stat'd at stage
   * time (rare; check is then skipped for that edit).
   */
  originalMtimeMs?: number;
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

/** Snapshot for dashboard / list endpoints. Only metadata — never the full
 * file content (could be large + sensitive). The `sizeBefore` / `sizeAfter`
 * UTF-8 byte counts are enough to render a meaningful row. */
export interface TransactionSnapshot {
  id: string;
  createdAt: number;
  expiresAt: number;
  edits: Array<{
    filePath: string;
    sizeBefore: number;
    sizeAfter: number;
    lineDelta: number;
  }>;
}

export function listActiveTransactions(): TransactionSnapshot[] {
  _cleanupExpiredTransactions();
  const out: TransactionSnapshot[] = [];
  for (const tx of transactions.values()) {
    out.push({
      id: tx.id,
      createdAt: tx.createdAt,
      expiresAt: tx.createdAt + TRANSACTION_TTL_MS,
      edits: tx.edits.map((e) => ({
        filePath: e.filePath,
        sizeBefore: Buffer.byteLength(e.originalContent, "utf-8"),
        sizeAfter: Buffer.byteLength(e.newContent, "utf-8"),
        lineDelta:
          e.newContent.split("\n").length -
          e.originalContent.split("\n").length,
      })),
    });
  }
  // newest first
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Used by HTTP commit/rollback endpoints (server.ts). Returns whether the
 * transaction existed. The actual write/discard happens via the same code
 * paths the MCP handlers use — keeping behavior identical. */
export function rollbackTransactionById(id: string): boolean {
  if (!transactions.has(id)) return false;
  transactions.delete(id);
  return true;
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
): { resolved: string; content: string; mtimeMs?: number } {
  const resolved = resolveFilePath(rawPath, workspace, { write: true });
  // stat before read so we capture the mtime as of the staged snapshot. If the
  // stat fails for any reason, fall through with mtimeMs undefined — the commit
  // conflict check is skipped for that edit rather than blocking the stage.
  let mtimeMs: number | undefined;
  try {
    mtimeMs = fs.statSync(resolved).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  const content = fs.readFileSync(resolved, "utf-8");
  return { resolved, content, mtimeMs };
}

/**
 * @param fileLock - Optional per-file lock. Reserved for future commit-time
 *   serialization plumbing (see follow-up: wire from src/tools/index.ts). The
 *   mtime-based optimistic-concurrency check works WITHOUT a lock and stands
 *   alone — the lock would only narrow the (already-small) window between the
 *   commit-time re-stat and the atomic write.
 */
export function createTransactionTools(workspace: string, fileLock?: FileLock) {
  // Referenced so the optional param is retained for future wiring without a
  // lint error; the mtime check below is independent of it.
  void fileLock;
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
      let originalMtimeMs: number | undefined;
      try {
        ({
          resolved,
          content: originalContent,
          mtimeMs: originalMtimeMs,
        } = resolveAndRead(rawPath, workspace));
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

      tx.edits.push({
        filePath: resolved,
        originalContent,
        newContent,
        originalMtimeMs,
      });
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
          // Optimistic-concurrency check: re-stat the file and compare against
          // the mtime captured at stage time. If it changed, an intervening
          // edit happened (editText/replaceBlock/external) — refuse to clobber
          // it. Matches the mtime guard in editText's native write path.
          if (edit.originalMtimeMs !== undefined) {
            let currentMtimeMs: number | undefined;
            try {
              currentMtimeMs = fs.statSync(edit.filePath).mtimeMs;
            } catch {
              // File was deleted between stage and commit.
              errors.push({
                file: edit.filePath,
                error:
                  "File was deleted after staging — commit aborted to avoid recreating a removed file",
              });
              continue;
            }
            if (currentMtimeMs !== edit.originalMtimeMs) {
              errors.push({
                file: edit.filePath,
                error:
                  "File was modified concurrently after staging — commit aborted to avoid clobbering the intervening edit. Re-stage this file.",
              });
              continue;
            }
          }

          await writeFileAtomic(edit.filePath, edit.newContent, {
            encoding: "utf-8",
          });
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
