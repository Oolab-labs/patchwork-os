import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResults } from "../probe.js";
import {
  execSafe,
  optionalInt,
  optionalString,
  successStructuredLarge,
} from "./utils.js";

const CACHE_TTL = 30_000;

interface DepNode {
  name: string;
  version?: string;
  deps?: DepNode[];
}

interface DepResult {
  packageManager: string;
  count: number;
  tree: DepNode | null;
  error?: string;
}

interface CacheEntry {
  data: DepResult;
  timestamp: number;
}

function detectPackageManager(workspace: string, hint?: string): string | null {
  if (hint && hint !== "auto") return hint;
  if (existsSync(join(workspace, "package.json"))) return "npm";
  if (existsSync(join(workspace, "Cargo.toml"))) return "cargo";
  if (existsSync(join(workspace, "go.mod"))) return "go";
  if (
    existsSync(join(workspace, "requirements.txt")) ||
    existsSync(join(workspace, "pyproject.toml"))
  )
    return "pip";
  return null;
}

function countNodes(node: DepNode): number {
  let count = 1;
  for (const dep of node.deps ?? []) {
    count += countNodes(dep);
  }
  return count;
}

async function runNpm(
  workspace: string,
  depth: number,
  signal?: AbortSignal,
): Promise<DepResult> {
  const result = await execSafe(
    "npm",
    ["ls", "--json", `--depth=${depth}`, "--all"],
    { cwd: workspace, signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  // npm ls exits non-zero if there are peer dep issues but still returns JSON
  const raw = result.stdout.trim();
  if (!raw) {
    throw new Error(result.stderr.trim() || "npm ls returned no output");
  }
  const parsed = JSON.parse(raw) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, unknown>;
  };

  function toNode(
    name: string,
    obj: { version?: string; dependencies?: Record<string, unknown> },
  ): DepNode {
    const node: DepNode = { name, version: obj.version };
    if (obj.dependencies) {
      node.deps = Object.entries(obj.dependencies).map(([n, v]) =>
        toNode(
          n,
          v as { version?: string; dependencies?: Record<string, unknown> },
        ),
      );
    }
    return node;
  }

  const tree: DepNode = {
    name: parsed.name ?? "app",
    version: parsed.version,
    deps: parsed.dependencies
      ? Object.entries(parsed.dependencies).map(([n, v]) =>
          toNode(
            n,
            v as { version?: string; dependencies?: Record<string, unknown> },
          ),
        )
      : [],
  };

  return { packageManager: "npm", count: countNodes(tree) - 1, tree };
}

async function runCargo(
  workspace: string,
  signal?: AbortSignal,
): Promise<DepResult> {
  const result = await execSafe(
    "cargo",
    ["metadata", "--no-deps", "--format-version=1"],
    { cwd: workspace, signal, timeout: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "cargo metadata failed");
  }
  const parsed = JSON.parse(result.stdout) as {
    packages: Array<{
      name: string;
      version: string;
      dependencies: Array<{ name: string; req: string }>;
    }>;
    root?: string;
  };

  const rootPkg = parsed.packages[0];
  if (!rootPkg) throw new Error("No packages found in cargo metadata");

  const tree: DepNode = {
    name: rootPkg.name,
    version: rootPkg.version,
    deps: rootPkg.dependencies.map((d) => ({
      name: d.name,
      version: d.req,
    })),
  };
  return { packageManager: "cargo", count: tree.deps?.length ?? 0, tree };
}

async function runGo(
  workspace: string,
  signal?: AbortSignal,
): Promise<DepResult> {
  const result = await execSafe("go", ["list", "-m", "-json", "all"], {
    cwd: workspace,
    signal,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "go list failed");
  }
  // go list -json all outputs multiple JSON objects concatenated
  const objects: Array<{ Path: string; Version?: string; Main?: boolean }> = [];
  const raw = result.stdout.trim();
  // Parse by splitting on `}\n{`
  const chunks = raw.replace(/\}\s*\n\s*\{/g, "}\n---\n{").split("\n---\n");
  for (const chunk of chunks) {
    try {
      objects.push(
        JSON.parse(chunk) as { Path: string; Version?: string; Main?: boolean },
      );
    } catch {
      // skip malformed chunks
    }
  }

  const main = objects.find((o) => o.Main);
  const deps = objects.filter((o) => !o.Main);
  const tree: DepNode = {
    name: main?.Path ?? "module",
    version: main?.Version,
    deps: deps.map((d) => ({ name: d.Path, version: d.Version })),
  };
  return { packageManager: "go", count: deps.length, tree };
}

async function runPip(
  workspace: string,
  signal?: AbortSignal,
): Promise<DepResult> {
  const result = await execSafe("pip", ["list", "--format=json"], {
    cwd: workspace,
    signal,
    timeout: 15_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "pip list failed");
  }
  const pkgs = JSON.parse(result.stdout) as Array<{
    name: string;
    version: string;
  }>;
  const tree: DepNode = {
    name: workspace.split("/").pop() ?? "project",
    deps: pkgs.map((p) => ({ name: p.name, version: p.version })),
  };
  return { packageManager: "pip", count: pkgs.length, tree };
}

export function createGetDependencyTreeTool(
  workspace: string,
  _probes?: ProbeResults,
) {
  const cache = new Map<string, CacheEntry>();

  return {
    schema: {
      name: "getDependencyTree",
      description:
        "Dependency tree (npm/cargo/go/pip). Auto-detects package manager. Returns names and versions.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          depth: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Max dependency depth (npm only). Default: 2",
          },
          packageManager: {
            type: "string",
            enum: ["npm", "pip", "cargo", "go", "auto"],
            description:
              "Package manager to use. Default: auto-detect from manifest files",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          packageManager: { type: ["string", "null"] },
          count: { type: "integer" },
          tree: { anyOf: [{ type: "object" }, { type: "null" }] },
          error: { type: "string" },
        },
        required: ["available", "packageManager"],
      },
    },
    timeoutMs: 35_000,

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const pm = optionalString(args, "packageManager") ?? "auto";
      const depthRaw = optionalInt(args, "depth", 1, 10) ?? 2;

      const cacheKey = `${pm}:${depthRaw}`;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && now - cached.timestamp < CACHE_TTL) {
        return successStructuredLarge(cached.data);
      }

      const detected = detectPackageManager(workspace, pm);
      if (!detected) {
        return successStructuredLarge({
          available: false,
          packageManager: null,
          error:
            "No supported package manifest found (package.json, Cargo.toml, go.mod, requirements.txt)",
        });
      }

      try {
        let result: DepResult;
        switch (detected) {
          case "npm":
            result = await runNpm(workspace, depthRaw, signal);
            break;
          case "cargo":
            result = await runCargo(workspace, signal);
            break;
          case "go":
            result = await runGo(workspace, signal);
            break;
          case "pip":
            result = await runPip(workspace, signal);
            break;
          default:
            return successStructuredLarge({
              available: false,
              packageManager: detected,
              error: `Unsupported package manager: ${detected}`,
            });
        }

        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        return successStructuredLarge({ available: true, ...result });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return successStructuredLarge({
          available: false,
          packageManager: detected,
          error: msg,
        });
      }
    },
  };
}
