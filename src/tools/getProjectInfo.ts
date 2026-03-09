import fs from "node:fs";
import path from "node:path";
import { execSafe, success } from "./utils.js";

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

interface CargoToml {
  package?: { name?: string; version?: string; edition?: string };
}

interface GoMod {
  module?: string;
  goVersion?: string;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function existsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function detectConfigFiles(workspace: string): string[] {
  const candidates = [
    // Build & bundle
    "tsconfig.json", "tsconfig.base.json",
    "vite.config.ts", "vite.config.js",
    "webpack.config.js", "webpack.config.ts",
    "rollup.config.js", "rollup.config.ts",
    "esbuild.mjs", "esbuild.js",
    // Test
    "vitest.config.ts", "vitest.config.js",
    "jest.config.ts", "jest.config.js",
    "pytest.ini", "pyproject.toml",
    // Lint & format
    ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs",
    ".prettierrc", ".prettierrc.json",
    "biome.json",
    // Runtime & framework
    "next.config.js", "next.config.ts", "next.config.mjs",
    "astro.config.mjs",
    "svelte.config.js",
    "nuxt.config.ts",
    // Container & infra
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    ".env.example",
    // CI
    ".github/workflows",
  ];
  return candidates.filter((c) => {
    const p = path.join(workspace, c);
    try {
      fs.statSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

function getTopLevelDirs(workspace: string): string[] {
  const ignored = new Set([
    "node_modules", ".git", ".next", "dist", "build", "out",
    ".cache", "__pycache__", ".venv", "venv", "target", ".turbo",
    "coverage", ".nyc_output",
  ]);
  try {
    return fs.readdirSync(workspace)
      .filter((entry) => {
        if (ignored.has(entry)) return false;
        try {
          return fs.statSync(path.join(workspace, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

async function getGitInfo(workspace: string): Promise<{
  branch: string | null;
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
} | null> {
  const check = await execSafe("git", ["rev-parse", "--git-dir"], { cwd: workspace, timeout: 3000 });
  if (check.exitCode !== 0) return null;

  const branchResult = await execSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace, timeout: 3000 });
  const branch = branchResult.stdout.trim() || null;

  let ahead = 0;
  let behind = 0;
  const rl = await execSafe("git", ["rev-list", "--count", "--left-right", "HEAD...@{u}"], { cwd: workspace, timeout: 3000 });
  if (rl.exitCode === 0) {
    const parts = rl.stdout.trim().split(/\s+/);
    ahead = parseInt(parts[0] ?? "0", 10);
    behind = parseInt(parts[1] ?? "0", 10);
  }

  const statusResult = await execSafe("git", ["status", "--porcelain"], { cwd: workspace, timeout: 3000 });
  const hasUncommittedChanges = statusResult.stdout.trim().length > 0;

  return { branch, ahead, behind, hasUncommittedChanges };
}

export function createGetProjectInfoTool(workspace: string) {
  return {
    schema: {
      name: "getProjectInfo",
      description:
        "Get a compact overview of the project at session start. " +
        "Returns: project name/version, detected languages, package manager, key scripts, " +
        "important dependencies, config files present, top-level directory structure, and git status. " +
        "Use this as the first call in a new session instead of manually reading package.json, " +
        "running getFileTree, and calling getGitStatus separately.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
    },
    handler: async () => {
      const projects: Array<Record<string, unknown>> = [];

      // --- Node.js / TypeScript ---
      const pkgPath = path.join(workspace, "package.json");
      if (existsFile(pkgPath)) {
        const pkg = readJsonSafe<PackageJson>(pkgPath);
        if (pkg) {
          const allDeps = {
            ...pkg.dependencies,
            ...pkg.devDependencies,
          };
          const hasTypeScript = "typescript" in allDeps || existsFile(path.join(workspace, "tsconfig.json"));

          // Detect package manager
          let packageManager = "npm";
          if (existsFile(path.join(workspace, "pnpm-lock.yaml"))) packageManager = "pnpm";
          else if (existsFile(path.join(workspace, "yarn.lock"))) packageManager = "yarn";
          else if (existsFile(path.join(workspace, "bun.lockb")) || existsFile(path.join(workspace, "bun.lock"))) packageManager = "bun";

          // Key framework detection
          const frameworks: string[] = [];
          const fwMap: Record<string, string> = {
            next: "Next.js", react: "React", vue: "Vue", svelte: "Svelte",
            astro: "Astro", express: "Express", fastify: "Fastify", hono: "Hono",
            vitest: "Vitest", jest: "Jest",
          };
          for (const [dep, label] of Object.entries(fwMap)) {
            if (dep in allDeps) frameworks.push(label);
          }

          // Condense scripts — skip boilerplate
          const scripts = pkg.scripts ?? {};
          const importantScripts = Object.fromEntries(
            Object.entries(scripts).filter(([k]) =>
              ["build", "dev", "start", "test", "lint", "check", "typecheck", "format"].includes(k),
            ),
          );

          projects.push({
            type: hasTypeScript ? "typescript" : "javascript",
            name: pkg.name ?? path.basename(workspace),
            version: pkg.version ?? null,
            description: pkg.description ?? null,
            packageManager,
            scripts: importantScripts,
            allScripts: Object.keys(scripts),
            frameworks,
            isMonorepo: !!pkg.workspaces,
          });
        }
      }

      // --- Rust ---
      const cargoPath = path.join(workspace, "Cargo.toml");
      if (existsFile(cargoPath)) {
        const content = readFileSafe(cargoPath);
        if (content) {
          const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
          const versionMatch = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
          const editionMatch = content.match(/^\s*edition\s*=\s*"([^"]+)"/m);
          projects.push({
            type: "rust",
            name: nameMatch?.[1] ?? path.basename(workspace),
            version: versionMatch?.[1] ?? null,
            edition: editionMatch?.[1] ?? null,
            isWorkspace: content.includes("[workspace]"),
          });
        }
      }

      // --- Go ---
      const goModPath = path.join(workspace, "go.mod");
      if (existsFile(goModPath)) {
        const content = readFileSafe(goModPath);
        if (content) {
          const moduleMatch = content.match(/^module\s+(\S+)/m);
          const goMatch = content.match(/^go\s+(\S+)/m);
          projects.push({
            type: "go",
            module: moduleMatch?.[1] ?? null,
            goVersion: goMatch?.[1] ?? null,
          });
        }
      }

      // --- Python ---
      const pyprojectPath = path.join(workspace, "pyproject.toml");
      const requirementsPath = path.join(workspace, "requirements.txt");
      const setupPyPath = path.join(workspace, "setup.py");
      if (existsFile(pyprojectPath) || existsFile(requirementsPath) || existsFile(setupPyPath)) {
        const pyproject = existsFile(pyprojectPath) ? readFileSafe(pyprojectPath) : null;
        const nameMatch = pyproject?.match(/^\s*name\s*=\s*"([^"]+)"/m);
        const versionMatch = pyproject?.match(/^\s*version\s*=\s*"([^"]+)"/m);

        // Detect test framework
        const testFramework = pyproject?.includes("pytest") || existsFile(path.join(workspace, "pytest.ini")) ? "pytest" : null;

        projects.push({
          type: "python",
          name: nameMatch?.[1] ?? path.basename(workspace),
          version: versionMatch?.[1] ?? null,
          testFramework,
          hasPyproject: existsFile(pyprojectPath),
          hasRequirements: existsFile(requirementsPath),
        });
      }

      // No recognized project type
      if (projects.length === 0) {
        projects.push({ type: "unknown", name: path.basename(workspace) });
      }

      // --- Shared context ---
      const topLevelDirs = getTopLevelDirs(workspace);
      const configFiles = detectConfigFiles(workspace);
      const gitInfo = await getGitInfo(workspace);

      // Count files by extension (top level + one level deep, fast estimate)
      const fileTypeCounts: Record<string, number> = {};
      try {
        const entries = fs.readdirSync(workspace);
        for (const entry of entries) {
          if (entry.startsWith(".") || entry === "node_modules") continue;
          const ext = path.extname(entry);
          if (ext) {
            fileTypeCounts[ext] = (fileTypeCounts[ext] ?? 0) + 1;
          }
        }
      } catch {
        // ignore
      }

      return success({
        workspace,
        project: projects.length === 1 ? projects[0] : projects,
        directories: topLevelDirs,
        configFiles,
        git: gitInfo,
        tip: "Use getFileTree for deep directory exploration, getGitStatus for staged/unstaged details, getToolCapabilities for available tools.",
      });
    },
  };
}
