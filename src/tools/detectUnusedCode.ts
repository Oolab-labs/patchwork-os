import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProbeResults } from "../probe.js";
import { execSafe, optionalArray, optionalInt, success } from "./utils.js";

interface UnusedItem {
  file: string;
  line: number;
  symbol: string;
  kind: "export" | "local" | "parameter";
}

export function createDetectUnusedCodeTool(
  workspace: string,
  _probes?: ProbeResults,
) {
  return {
    schema: {
      name: "detectUnusedCode",
      description:
        "Find unused exports, locals, and parameters using TypeScript compiler analysis (tsc --noUnusedLocals) or ts-prune if available. Returns file paths, line numbers, and symbol names.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          includePatterns: {
            type: "array",
            items: { type: "string" },
            description: "File patterns to include, e.g. ['src/**/*.ts']",
          },
          maxResults: {
            type: "number",
            description: "Max number of unused symbols to return (default 50)",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 60_000,

    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ReturnType<typeof success>> {
      const maxResults = optionalInt(args, "maxResults", 1, 10_000) ?? 50;
      // includePatterns stored for future filtering — currently unused
      optionalArray(args, "includePatterns");

      // Try ts-prune first — invoke the local binary directly to avoid npx
      // spawning an extra process and potentially picking up a different version.
      const tsPruneBin = join(workspace, "node_modules", ".bin", "ts-prune");
      if (existsSync(tsPruneBin)) {
        const result = await execSafe(tsPruneBin, ["--error"], {
          cwd: workspace,
          signal,
          timeout: 55_000,
          maxBuffer: 4 * 1024 * 1024,
        });

        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (output) {
          const items = parseTsPruneOutput(output, workspace);
          const truncated = items.length > maxResults;
          return success({
            available: true,
            detector: "ts-prune",
            total: items.length,
            items: items.slice(0, maxResults),
            truncated,
          });
        }
      }

      // Fall back to tsc --noUnusedLocals --noUnusedParameters
      const result = await execSafe(
        "npx",
        ["tsc", "--noEmit", "--noUnusedLocals", "--noUnusedParameters"],
        {
          cwd: workspace,
          signal,
          timeout: 55_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );

      const output = `${result.stdout}\n${result.stderr}`.trim();

      // Check if tsc is available (ENOENT or "not found" in stderr with no useful output)
      if (
        result.exitCode !== 0 &&
        !output &&
        (result.stderr.includes("ENOENT") ||
          result.stderr.includes("not found"))
      ) {
        return success({
          available: false,
          error:
            "No unused code detector available. Install ts-prune: npm install -D ts-prune",
        });
      }

      const items = parseTscOutput(output, workspace);
      if (items.length === 0 && result.exitCode !== 0 && !output) {
        return success({
          available: false,
          error:
            "No unused code detector available. Install ts-prune: npm install -D ts-prune",
        });
      }

      const truncated = items.length > maxResults;
      return success({
        available: true,
        detector: "tsc",
        total: items.length,
        items: items.slice(0, maxResults),
        truncated,
      });
    },
  };
}

function parseTsPruneOutput(output: string, workspace: string): UnusedItem[] {
  const items: UnusedItem[] = [];
  // Format: "src/file.ts:12 - functionName"
  const re = /^(.+?):(\d+)\s+-\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const filePath = m[1]?.trim() ?? "";
    const line = Number.parseInt(m[2] ?? "0", 10);
    const symbol = m[3]?.trim() ?? "";
    if (!filePath || !symbol) continue;
    const rel = filePath.startsWith("/")
      ? relative(workspace, filePath)
      : filePath;
    items.push({ file: rel, line, symbol, kind: "export" });
  }
  return items;
}

function parseTscOutput(output: string, workspace: string): UnusedItem[] {
  const items: UnusedItem[] = [];
  // Format: "src/file.ts(12,5): error TS6133: 'foo' is declared but its value is never read."
  // TS6192: "All destructured elements are unused." (no quoted symbol)
  // TS6196: similar
  const re =
    /^(.+?)\((\d+),\d+\):\s+error\s+(TS6133|TS6192|TS6196):\s+(?:'(.+?)'.*|(.+))$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const filePath = m[1]?.trim() ?? "";
    const line = Number.parseInt(m[2] ?? "0", 10);
    const code = m[3] ?? "";
    // TS6133 has a quoted symbol (m[4]); TS6192/TS6196 may not (use m[5] as fallback)
    const symbol = (m[4] ?? m[5] ?? "").trim();
    if (!filePath || !symbol) continue;
    const rel = filePath.startsWith("/")
      ? relative(workspace, filePath)
      : filePath;
    const kind: "export" | "local" | "parameter" =
      code === "TS6192" || code === "TS6196" ? "parameter" : "local";
    items.push({ file: rel, line, symbol, kind });
  }
  return items;
}
