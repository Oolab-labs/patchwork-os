import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResults } from "../probe.js";
import { execSafe, optionalString, success } from "./utils.js";

const CACHE_TTL = 60_000;

interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
}

interface OutdatedResult {
  available: true;
  packageManager: string;
  total: number;
  packages: OutdatedPackage[];
}

interface CacheEntry {
  data: OutdatedResult;
  timestamp: number;
}

function detectManager(workspace: string, hint?: string): string | null {
  if (hint && hint !== "auto") return hint;
  if (existsSync(join(workspace, "package.json"))) return "npm";
  if (existsSync(join(workspace, "Cargo.toml"))) return "cargo";
  if (
    existsSync(join(workspace, "requirements.txt")) ||
    existsSync(join(workspace, "pyproject.toml"))
  )
    return "pip";
  return null;
}

async function runNpmOutdated(
  workspace: string,
  signal?: AbortSignal,
): Promise<OutdatedPackage[]> {
  const result = await execSafe("npm", ["outdated", "--json"], {
    cwd: workspace,
    signal,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // Check for binary-not-found errors before trying to parse output
  const errText = result.stderr.trim();
  if (
    errText &&
    (errText.includes("ENOENT") || errText.includes("not found")) &&
    !result.stdout.trim()
  ) {
    throw new Error(errText);
  }

  // npm outdated exits 1 when packages are outdated — normal behavior
  const raw = result.stdout.trim();
  if (!raw) return [];

  let parsed: Record<
    string,
    { current?: string; wanted?: string; latest?: string }
  >;
  try {
    parsed = JSON.parse(raw) as Record<
      string,
      { current?: string; wanted?: string; latest?: string }
    >;
  } catch {
    throw new Error(
      `npm outdated returned non-JSON output: ${raw.slice(0, 200)}`,
    );
  }

  return Object.entries(parsed).map(([name, info]) => ({
    name,
    current: info.current ?? "unknown",
    wanted: info.wanted ?? info.latest ?? "unknown",
    latest: info.latest ?? "unknown",
  }));
}

async function runCargoOutdated(
  workspace: string,
  signal?: AbortSignal,
): Promise<OutdatedPackage[]> {
  const result = await execSafe("cargo", ["update", "--dry-run"], {
    cwd: workspace,
    signal,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // cargo update --dry-run writes to stderr
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const packages: OutdatedPackage[] = [];

  // Lines like: "Updating foo v1.0.0 -> v1.1.0"
  const re = /Updating\s+(\S+)\s+v([\d.]+(?:-\S+)?)\s+->\s+v([\d.]+(?:-\S+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    packages.push({
      name: m[1] ?? "",
      current: m[2] ?? "unknown",
      wanted: m[3] ?? "unknown",
      latest: m[3] ?? "unknown",
    });
  }
  return packages;
}

async function runPipOutdated(
  workspace: string,
  signal?: AbortSignal,
): Promise<OutdatedPackage[]> {
  const result = await execSafe(
    "pip",
    ["list", "--outdated", "--format=json"],
    {
      cwd: workspace,
      signal,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  const raw = result.stdout.trim();
  if (!raw) return [];

  let parsed: Array<{ name: string; version: string; latest_version: string }>;
  try {
    parsed = JSON.parse(raw) as Array<{
      name: string;
      version: string;
      latest_version: string;
    }>;
  } catch {
    throw new Error(`pip list returned non-JSON output: ${raw.slice(0, 200)}`);
  }

  return parsed.map((p) => ({
    name: p.name,
    current: p.version,
    wanted: p.latest_version,
    latest: p.latest_version,
  }));
}

export function createAuditDependenciesTool(
  workspace: string,
  _probes?: ProbeResults,
) {
  const cache = new Map<string, CacheEntry>();

  return {
    schema: {
      name: "auditDependencies",
      description:
        "Detect outdated packages (complement to getSecurityAdvisories which finds vulnerabilities). Reports current vs. latest versions. Supports npm, cargo, and pip. Auto-detects package manager from manifest files.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          packageManager: {
            type: "string",
            enum: ["auto", "npm", "cargo", "pip"],
            description: "Package manager to use. Defaults to 'auto'.",
          },
          maxAge: {
            type: "number",
            description:
              "Only report packages where versions differ by major (1) or minor (2) increments — reserved for future use.",
          },
        },
        additionalProperties: false as const,
      },
    },
    timeoutMs: 65_000,

    async handler(
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ReturnType<typeof success>> {
      const pm = optionalString(args, "packageManager") ?? "auto";
      const cacheKey = pm;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && now - cached.timestamp < CACHE_TTL) {
        return success(cached.data);
      }

      const detected = detectManager(workspace, pm);
      if (!detected) {
        return success({
          available: false,
          packageManager: null,
          error:
            "No supported package manifest found (package.json, Cargo.toml, requirements.txt, pyproject.toml)",
        });
      }

      try {
        let packages: OutdatedPackage[];
        switch (detected) {
          case "npm":
            packages = await runNpmOutdated(workspace, signal);
            break;
          case "cargo":
            packages = await runCargoOutdated(workspace, signal);
            break;
          case "pip":
            packages = await runPipOutdated(workspace, signal);
            break;
          default:
            return success({
              available: false,
              packageManager: detected,
              error: `Unsupported package manager: ${detected}`,
            });
        }

        const result: OutdatedResult = {
          available: true,
          packageManager: detected,
          total: packages.length,
          packages,
        };
        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        return success(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT") || msg.includes("not found")) {
          return success({
            available: false,
            packageManager: detected,
            error: `${detected} not found. ${msg}`,
          });
        }
        return success({
          available: false,
          packageManager: detected,
          error: msg,
        });
      }
    },
  };
}
