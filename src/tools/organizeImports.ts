import fs from "node:fs";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import {
  error,
  execSafe,
  requireString,
  resolveFilePath,
  success,
} from "./utils.js";

async function organizeImportsNative(
  resolved: string,
  workspace: string,
): Promise<{ source: string } | null> {
  const biome = await execSafe(
    "npx",
    [
      "--no-install",
      "biome",
      "check",
      "--apply",
      "--formatter-enabled=false",
      "--linter-enabled=false",
      "--organize-imports-enabled=true",
      resolved,
    ],
    { cwd: workspace, timeout: 30_000 },
  );
  if (biome.exitCode === 0) return { source: "biome" };

  const prettier = await execSafe(
    "npx",
    ["--no-install", "prettier", "--write", resolved],
    { cwd: workspace, timeout: 30_000 },
  );
  if (prettier.exitCode === 0) return { source: "prettier" };

  return null;
}

export function createOrganizeImportsTool(
  workspace: string,
  extensionClient: ExtensionClient,
) {
  return {
    schema: {
      name: "organizeImports",
      description:
        "Organize and sort imports in a file. Uses VS Code extension when connected; falls back to Biome or Prettier CLI otherwise.",
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: {
            type: "string",
            description:
              "Path to the file to organize imports in (relative to workspace or absolute)",
          },
        },
        required: ["filePath"],
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>, _signal?: AbortSignal) => {
      const rawPath = requireString(args, "filePath");
      const resolved = resolveFilePath(rawPath, workspace, { write: true });

      let contentBefore: string;
      try {
        contentBefore = fs.readFileSync(resolved, "utf-8");
      } catch {
        return error({ error: `File not found: ${rawPath}` });
      }

      if (!extensionClient.isConnected()) {
        const nativeResult = await organizeImportsNative(resolved, workspace);
        if (!nativeResult) {
          return error({
            error:
              "Extension not connected and no CLI formatter (biome/prettier) available — cannot organize imports",
          });
        }
        let contentAfter: string;
        try {
          contentAfter = fs.readFileSync(resolved, "utf-8");
        } catch {
          return error({ error: "File unreadable after organize operation" });
        }
        return success({
          organized: true,
          source: nativeResult.source,
          changes: contentBefore === contentAfter ? "none" : "modified",
          linesBeforeCount: contentBefore.split("\n").length,
          linesAfterCount: contentAfter.split("\n").length,
        });
      }

      let result: unknown;
      try {
        result = await extensionClient.organizeImports(resolved);
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error(
            "Extension timed out — organize imports may require more time",
          );
        }
        throw err;
      }
      if (result === null) {
        return error({
          error: "Extension failed to organize imports",
        });
      }

      let contentAfter: string;
      try {
        contentAfter = fs.readFileSync(resolved, "utf-8");
      } catch {
        return error({ error: "File unreadable after organize operation" });
      }
      return success({
        organized: true,
        source: "extension",
        changes: contentBefore === contentAfter ? "none" : "modified",
        linesBeforeCount: contentBefore.split("\n").length,
        linesAfterCount: contentAfter.split("\n").length,
      });
    },
  };
}
