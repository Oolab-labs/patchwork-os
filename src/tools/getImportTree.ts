import fs from "node:fs";
import path from "node:path";
import { optionalBool, optionalInt, requireString, success } from "./utils.js";

interface TreeNode {
  file: string;
  relativePath: string;
  imports: TreeNode[];
  external?: string[];
  cycle?: boolean;
}

const EXTENSIONS_TO_TRY = [
  "",
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  "/index.ts",
  "/index.js",
];

function resolveLocalImport(
  specifier: string,
  fromDir: string,
): string | null {
  const base = path.resolve(fromDir, specifier);
  for (const ext of EXTENSIONS_TO_TRY) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseImports(source: string): { local: string[]; external: string[] } {
  const local: string[] = [];
  const external: string[] = [];

  const specifiers = new Set<string>();

  // ES module static imports
  const esImportRe =
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(esImportRe)) {
    if (m[1]) specifiers.add(m[1]);
  }

  // Dynamic import()
  const dynImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(dynImportRe)) {
    if (m[1]) specifiers.add(m[1]);
  }

  // CommonJS require()
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(requireRe)) {
    if (m[1]) specifiers.add(m[1]);
  }

  for (const spec of specifiers) {
    if (spec.startsWith(".")) {
      local.push(spec);
    } else {
      external.push(spec);
    }
  }

  return { local, external };
}

export function createGetImportTreeTool(workspace: string) {
  return {
    schema: {
      name: "getImportTree",
      description:
        "Parse import statements in a file and build a tree of local (workspace-relative) imports. Useful for understanding module dependencies and finding circular imports.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["file"],
        properties: {
          file: { type: "string" },
          maxDepth: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Max recursion depth (default: 3)",
          },
          includeExternal: {
            type: "boolean",
            description: "Include external package imports in output (default: false)",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      const file = requireString(args, "file");
      const maxDepth = optionalInt(args, "maxDepth", 1, 10) ?? 3;
      const includeExternal = optionalBool(args, "includeExternal") ?? false;

      const absFile = path.isAbsolute(file)
        ? file
        : path.resolve(workspace, file);

      const visited = new Set<string>();
      const cycles: string[] = [];
      let totalFiles = 0;

      // BFS queue: { absPath, parentNode, depth }
      interface QueueItem {
        absPath: string;
        depth: number;
        nodeRef: TreeNode;
      }

      // Build root node first
      let source: string;
      try {
        source = await fs.promises.readFile(absFile, "utf-8");
      } catch {
        return success({ file: absFile, tree: null, error: `Cannot read file: ${absFile}`, cycles: [], totalFiles: 0, maxDepth });
      }

      const relPath = absFile.startsWith(workspace + path.sep)
        ? absFile.slice(workspace.length + 1)
        : absFile;

      const rootNode: TreeNode = {
        file: absFile,
        relativePath: relPath,
        imports: [],
      };
      if (includeExternal) rootNode.external = [];

      visited.add(absFile);
      totalFiles++;

      const queue: QueueItem[] = [{ absPath: absFile, depth: 1, nodeRef: rootNode }];

      while (queue.length > 0) {
        const item = queue.shift()!;
        const { absPath, depth, nodeRef } = item;

        let src: string;
        if (absPath === absFile) {
          src = source;
        } else {
          try {
            src = await fs.promises.readFile(absPath, "utf-8");
          } catch {
            continue;
          }
        }

        const { local, external } = parseImports(src);

        if (includeExternal && nodeRef.external !== undefined) {
          nodeRef.external.push(...external);
        } else if (includeExternal) {
          nodeRef.external = [...external];
        }

        for (const spec of local) {
          const resolvedPath = resolveLocalImport(spec, path.dirname(absPath));
          if (!resolvedPath) continue;

          if (visited.has(resolvedPath)) {
            // Cycle detected
            const cycleRel = resolvedPath.startsWith(workspace + path.sep)
              ? resolvedPath.slice(workspace.length + 1)
              : resolvedPath;
            const cycleNode: TreeNode = {
              file: resolvedPath,
              relativePath: cycleRel,
              imports: [],
              cycle: true,
            };
            nodeRef.imports.push(cycleNode);
            if (!cycles.includes(resolvedPath)) cycles.push(resolvedPath);
            continue;
          }

          const childRel = resolvedPath.startsWith(workspace + path.sep)
            ? resolvedPath.slice(workspace.length + 1)
            : resolvedPath;

          const childNode: TreeNode = {
            file: resolvedPath,
            relativePath: childRel,
            imports: [],
          };
          if (includeExternal) childNode.external = [];

          nodeRef.imports.push(childNode);
          visited.add(resolvedPath);
          totalFiles++;

          if (depth < maxDepth) {
            queue.push({ absPath: resolvedPath, depth: depth + 1, nodeRef: childNode });
          }
        }
      }

      return success({
        file: absFile,
        tree: rootNode,
        cycles,
        totalFiles,
        maxDepth,
      });
    },
  };
}
