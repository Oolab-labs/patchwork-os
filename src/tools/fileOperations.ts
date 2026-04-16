import fs from "node:fs";
import path from "node:path";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  makeRelative,
  optionalBool,
  optionalString,
  requireString,
  resolveFilePath,
  successStructured,
} from "./utils.js";

export function createCreateFileTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "createFile",
      description:
        "Create file or directory within workspace. Uses VS Code when connected, native fs fallback.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute path for new file or directory",
          },
          content: {
            type: "string" as const,
            description: "Initial file content (default: empty)",
          },
          isDirectory: {
            type: "boolean" as const,
            description:
              "Create a directory instead of a file (default: false)",
          },
          overwrite: {
            type: "boolean" as const,
            description: "Overwrite if file already exists (default: false)",
          },
          openAfterCreate: {
            type: "boolean" as const,
            description: "Open file in editor after creation (default: true)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          created: { type: "boolean" },
          filePath: { type: "string" },
          isDirectory: { type: "boolean" },
          source: { type: "string" },
        },
        required: ["created"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const content = optionalString(args, "content", 1_048_576) ?? "";
      const isDirectory = optionalBool(args, "isDirectory") ?? false;
      const overwrite = optionalBool(args, "overwrite") ?? false;
      const openAfterCreate = optionalBool(args, "openAfterCreate") ?? true;

      const filePath = resolveFilePath(rawPath, workspace, { write: true });

      // Try extension first (can also open the file in editor)
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.createFile(
            filePath,
            content,
            isDirectory,
            overwrite,
            openAfterCreate,
          );
          if (result !== null) {
            return successStructured(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

      // Bail out before touching the filesystem if the call was already cancelled
      if (signal?.aborted) throw new Error("Request aborted");

      // Native fs fallback
      try {
        if (isDirectory) {
          await fs.promises.mkdir(filePath, { recursive: true });
        } else {
          // Ensure parent directory exists
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          if (!overwrite) {
            // Atomic exclusive-create: fails with EEXIST if file already exists (no TOCTOU race)
            try {
              await fs.promises.writeFile(filePath, content, {
                encoding: "utf-8",
                flag: "wx",
                signal,
              });
            } catch (err: unknown) {
              if (
                err instanceof Error &&
                (err as NodeJS.ErrnoException).code === "EEXIST"
              ) {
                return error(
                  `File already exists: ${filePath} (set overwrite: true to replace)`,
                );
              }
              throw err;
            }
          } else {
            await fs.promises.writeFile(filePath, content, {
              encoding: "utf-8",
              signal,
            });
          }
        }
        return successStructured({
          created: true,
          filePath: makeRelative(filePath, workspace),
          isDirectory,
          source: extensionClient.isConnected()
            ? "native-fs (extension timed out)"
            : "native-fs",
        });
      } catch (err) {
        return error(
          `Failed to create ${isDirectory ? "directory" : "file"}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export function createDeleteFileTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "deleteFile",
      description:
        "Delete workspace file or directory. VS Code (with trash) when connected, native fs fallback.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Workspace or absolute path to delete",
          },
          recursive: {
            type: "boolean" as const,
            description:
              "Delete directory contents recursively (default: false)",
          },
          useTrash: {
            type: "boolean" as const,
            description:
              "Move to trash instead of permanent delete (default: true)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          filePath: { type: "string" },
          source: { type: "string" },
          warning: { type: "string" },
        },
        required: ["deleted"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const recursive = optionalBool(args, "recursive") ?? false;
      const useTrash = optionalBool(args, "useTrash") ?? true;

      const filePath = resolveFilePath(rawPath, workspace, { write: true });

      // Try extension first (supports trash)
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.deleteFile(
            filePath,
            recursive,
            useTrash,
          );
          if (result !== null) {
            return successStructured(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

      if (signal?.aborted) throw new Error("Request aborted");

      // Native fs fallback (no trash support — permanent delete only)
      try {
        // Check trash first: it is the more actionable error when the extension
        // is not connected. Checking it before stat avoids returning a misleading
        // "recursive required" error when the real problem is the missing extension.
        if (useTrash) {
          return error(
            "VS Code extension not connected — native fallback cannot move to trash. " +
              "Set useTrash: false for permanent deletion, or reconnect the extension.",
          );
        }
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory() && !recursive) {
          return error("Cannot delete directory without recursive: true");
        }
        await fs.promises.rm(filePath, { recursive, force: false });
        return successStructured({
          deleted: true,
          filePath: makeRelative(filePath, workspace),
          source: extensionClient.isConnected()
            ? "native-fs (extension timed out)"
            : "native-fs",
          warning: "Permanently deleted (not moved to trash)",
        });
      } catch (err) {
        return error(
          `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

export function createRenameFileTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "renameFile",
      description:
        "Rename or move workspace file/directory. Uses VS Code when connected, native fs fallback.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["oldPath", "newPath"],
        properties: {
          oldPath: {
            type: "string" as const,
            description: "Current absolute or workspace-relative path",
          },
          newPath: {
            type: "string" as const,
            description: "New absolute or workspace-relative path",
          },
          overwrite: {
            type: "boolean" as const,
            description: "Overwrite if target already exists (default: false)",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          renamed: { type: "boolean" },
          oldPath: { type: "string" },
          newPath: { type: "string" },
          source: { type: "string" },
        },
        required: ["renamed"],
      },
    },
    handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
      const rawOld = requireString(args, "oldPath");
      const rawNew = requireString(args, "newPath");
      const overwrite = optionalBool(args, "overwrite") ?? false;

      const oldPath = resolveFilePath(rawOld, workspace);
      const newPath = resolveFilePath(rawNew, workspace, { write: true });

      // Try extension first
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.renameFile(
            oldPath,
            newPath,
            overwrite,
          );
          if (result !== null) {
            return successStructured(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

      if (signal?.aborted) throw new Error("Request aborted");

      // Native fs fallback
      try {
        // Ensure target parent directory exists before any move attempt
        await fs.promises.mkdir(path.dirname(newPath), { recursive: true });
        if (!overwrite) {
          // Use link(2) + unlink(2) for an atomic "move only if dest does not exist"
          // when both paths are on the same filesystem. link(2) fails with EEXIST
          // atomically, eliminating the TOCTOU window of a separate access() check.
          try {
            await fs.promises.link(oldPath, newPath);
            try {
              await fs.promises.unlink(oldPath);
            } catch (unlinkErr) {
              // link() succeeded but unlink() failed — both paths now point to the
              // same inode. Clean up the newly created hardlink so the file stays
              // only at its original location, then surface the error to the caller.
              try {
                await fs.promises.unlink(newPath);
              } catch {
                /* best-effort */
              }
              throw unlinkErr;
            }
          } catch (linkErr) {
            const code = (linkErr as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              return error(
                `Target already exists: ${newPath} (set overwrite: true to replace)`,
              );
            }
            // Cross-device link not permitted — fall back to best-effort check + rename.
            // NOTE: access()+rename() is not atomic (TOCTOU): a concurrent process
            // could create newPath between the two calls, causing a silent overwrite.
            // This is an inherent limitation of cross-device moves without a lock;
            // same-device moves use the atomic link()+unlink() path above.
            if (code !== "EXDEV") throw linkErr;
            try {
              await fs.promises.access(newPath);
              return error(
                `Target already exists: ${newPath} (set overwrite: true to replace)`,
              );
            } catch {
              // Target doesn't exist — proceed (best-effort on cross-device moves)
            }
            await fs.promises.rename(oldPath, newPath);
          }
        } else {
          await fs.promises.rename(oldPath, newPath);
        }
        return successStructured({
          renamed: true,
          oldPath: makeRelative(oldPath, workspace),
          newPath: makeRelative(newPath, workspace),
          source: extensionClient.isConnected()
            ? "native-fs (extension timed out)"
            : "native-fs",
        });
      } catch (err) {
        return error(
          `Failed to rename: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
