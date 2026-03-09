import fs from "node:fs";
import path from "node:path";
import { ExtensionTimeoutError, type ExtensionClient } from "../extensionClient.js";
import {
  requireString,
  optionalString,
  optionalBool,
  resolveFilePath,
  success,
  error,
} from "./utils.js";

export function createCreateFileTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "createFile",
      description:
        "Create a new file or directory in the workspace. Uses VS Code when connected, falls back to native fs otherwise (openAfterCreate ignored in fallback mode).",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path for the new file or directory",
          },
          content: {
            type: "string" as const,
            description: "Initial file content (default: empty)",
          },
          isDirectory: {
            type: "boolean" as const,
            description: "Create a directory instead of a file (default: false)",
          },
          overwrite: {
            type: "boolean" as const,
            description: "Overwrite if file already exists (default: false)",
          },
          openAfterCreate: {
            type: "boolean" as const,
            description: "Open the file in editor after creation (default: true)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const rawPath = requireString(args, "filePath");
      const content = optionalString(args, "content", 1_048_576) ?? "";
      const isDirectory = optionalBool(args, "isDirectory") ?? false;
      const overwrite = optionalBool(args, "overwrite") ?? false;
      const openAfterCreate = optionalBool(args, "openAfterCreate") ?? true;

      const filePath = resolveFilePath(rawPath, workspace);

      // Try extension first (can also open the file in editor)
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.createFile(filePath, content, isDirectory, overwrite, openAfterCreate);
          if (result !== null) {
            return success(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

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
              await fs.promises.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
            } catch (err: unknown) {
              if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
                return error(`File already exists: ${filePath} (set overwrite: true to replace)`);
              }
              throw err;
            }
          } else {
            await fs.promises.writeFile(filePath, content, "utf-8");
          }
        }
        return success({
          created: true,
          filePath,
          isDirectory,
          source: extensionClient.isConnected() ? "native-fs (extension timed out)" : "native-fs",
        });
      } catch (err) {
        return error(`Failed to create ${isDirectory ? "directory" : "file"}: ${err instanceof Error ? err.message : String(err)}`);
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
        "Delete a file or directory in the workspace. Uses VS Code when connected (supports trash), falls back to native fs for permanent deletion.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string" as const,
            description: "Absolute or workspace-relative path to delete",
          },
          recursive: {
            type: "boolean" as const,
            description: "Delete directory contents recursively (default: false)",
          },
          useTrash: {
            type: "boolean" as const,
            description: "Move to trash instead of permanent delete (default: true)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const rawPath = requireString(args, "filePath");
      const recursive = optionalBool(args, "recursive") ?? false;
      const useTrash = optionalBool(args, "useTrash") ?? true;

      const filePath = resolveFilePath(rawPath, workspace);

      // Try extension first (supports trash)
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.deleteFile(filePath, recursive, useTrash);
          if (result !== null) {
            return success(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

      // Native fs fallback (no trash support — permanent delete only)
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory() && !recursive) {
          return error("Cannot delete directory without recursive: true");
        }
        if (useTrash) {
          // Cannot move to trash without the extension — warn the user
          return error(
            "VS Code extension not connected — native fallback cannot move to trash. " +
            "Set useTrash: false for permanent deletion, or reconnect the extension.",
          );
        }
        await fs.promises.rm(filePath, { recursive, force: false });
        return success({
          deleted: true,
          filePath,
          source: extensionClient.isConnected() ? "native-fs (extension timed out)" : "native-fs",
          warning: "Permanently deleted (not moved to trash)",
        });
      } catch (err) {
        return error(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
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
        "Rename or move a file or directory within the workspace. Uses VS Code when connected, falls back to native fs otherwise.",
      annotations: { readOnlyHint: false },
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
    },
    handler: async (args: Record<string, unknown>) => {
      const rawOld = requireString(args, "oldPath");
      const rawNew = requireString(args, "newPath");
      const overwrite = optionalBool(args, "overwrite") ?? false;

      const oldPath = resolveFilePath(rawOld, workspace);
      const newPath = resolveFilePath(rawNew, workspace);

      // Try extension first
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.renameFile(oldPath, newPath, overwrite);
          if (result !== null) {
            return success(result);
          }
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
          // Timeout — fall through to native fs fallback
        }
      }

      // Native fs fallback
      // Note: the overwrite check is best-effort (TOCTOU) since Node.js has no
      // atomic "rename only if destination does not exist" API.
      try {
        if (!overwrite) {
          try {
            await fs.promises.access(newPath);
            return error(`Target already exists: ${newPath} (set overwrite: true to replace)`);
          } catch {
            // Target doesn't exist — good (best-effort check)
          }
        }
        // Ensure target parent directory exists
        await fs.promises.mkdir(path.dirname(newPath), { recursive: true });
        await fs.promises.rename(oldPath, newPath);
        return success({
          renamed: true,
          oldPath,
          newPath,
          source: extensionClient.isConnected() ? "native-fs (extension timed out)" : "native-fs",
        });
      } catch (err) {
        return error(`Failed to rename: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
