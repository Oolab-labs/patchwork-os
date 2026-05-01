/**
 * Plugin loader for Claude IDE Bridge.
 *
 * Discovers, validates, and dynamically imports plugin packages declared via
 * --plugin CLI flags or the `plugins` config file key.
 *
 * Security model:
 *  - Plugins are never auto-discovered. They must be explicitly declared.
 *  - Plugins run in-process with full Node.js access (no sandbox).
 *  - The `toolNamePrefix` field is enforced to prevent collision with built-in tools.
 *  - Sensitive config fields (authToken, etc.) are not exposed to plugins.
 *  - Each plugin load failure is isolated — a bad plugin is skipped, not fatal.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { TOOL_CATEGORIES } from "./tools/index.js";

/**
 * Names of all built-in tools. Plugins are forbidden from registering a
 * tool with one of these names — without this guard, a plugin declaring
 * `toolNamePrefix: "git_"` could register `git_status` and silently shadow
 * the built-in. `TOOL_CATEGORIES` keys are the canonical source of truth
 * (every built-in tool is categorized for the dashboard).
 *
 * Exported so `PluginWatcher` can seed its hot-reload collision check with
 * the same set of built-in names — without this, hot-reload only blocks
 * collisions across sibling plugins, leaving built-ins shadowable.
 */
export function getBuiltInToolNames(): string[] {
  return Object.keys(TOOL_CATEGORIES);
}

import type {
  PluginContext,
  PluginManifest,
  PluginRegisterFn,
  PluginRegistration,
  PluginToolRegistration,
} from "./plugin.js";
import type { ToolHandler, ToolSchema } from "./transport.js";
import { PACKAGE_VERSION } from "./version.js";

const MANIFEST_FILE = "claude-ide-bridge-plugin.json";
const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_TOOLS_PER_PLUGIN = 100;

/** Runtime package version — compared against minBridgeVersion. */
const BRIDGE_VERSION = PACKAGE_VERSION;

// ── Semver helpers ────────────────────────────────────────────────────────────

/** Parse a semver string into [major, minor, patch]. Returns null on bad input. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns true if `actual` satisfies `>= required`. */
function semverGte(actual: string, required: string): boolean {
  const a = parseSemver(actual);
  const r = parseSemver(required);
  if (!a || !r) return true; // malformed — don't block
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (r[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (r[i] ?? 0)) return false;
  }
  return true; // equal
}

// ── Manifest validation ───────────────────────────────────────────────────────

const PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,19}$/;

function validateManifest(
  raw: unknown,
  source: string,
): { ok: true; manifest: PluginManifest } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "manifest is not a JSON object" };
  }
  const m = raw as Record<string, unknown>;

  if (m.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported schemaVersion ${String(m.schemaVersion)} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    };
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    return { ok: false, reason: '"name" must be a non-empty string' };
  }
  if (typeof m.entrypoint !== "string" || m.entrypoint.length === 0) {
    return { ok: false, reason: '"entrypoint" must be a non-empty string' };
  }
  if (typeof m.toolNamePrefix !== "string") {
    return { ok: false, reason: '"toolNamePrefix" must be a string' };
  }
  if (!PREFIX_RE.test(m.toolNamePrefix)) {
    return {
      ok: false,
      reason: `"toolNamePrefix" "${m.toolNamePrefix}" must match /^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`,
    };
  }
  if (m.version !== undefined && typeof m.version !== "string") {
    return { ok: false, reason: '"version" must be a string if present' };
  }
  if (
    m.permissions !== undefined &&
    (!Array.isArray(m.permissions) ||
      m.permissions.some((p) => typeof p !== "string"))
  ) {
    return {
      ok: false,
      reason: '"permissions" must be an array of strings if present',
    };
  }

  void source; // used by caller for log context
  return { ok: true, manifest: m as unknown as PluginManifest };
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a plugin specifier to a directory path.
 * - Relative/absolute paths are resolved directly.
 * - Package names are resolved via require.resolve from cwd.
 */
function resolvePluginDir(spec: string): string {
  if (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    path.isAbsolute(spec)
  ) {
    return path.resolve(spec);
  }
  // npm package — find the package.json via require.resolve, then take its directory
  const req = createRequire(path.join(process.cwd(), "noop.js"));
  const pkgJsonPath = req.resolve(`${spec}/package.json`);
  return path.dirname(pkgJsonPath);
}

// ── Plugin load ───────────────────────────────────────────────────────────────

export interface LoadedPluginTool {
  schema: ToolSchema;
  handler: ToolHandler;
  timeoutMs?: number;
}

export interface LoadedPlugin {
  spec: string;
  pluginDir: string;
  manifest: PluginManifest;
  tools: LoadedPluginTool[];
}

/**
 * Load all plugins declared in config.plugins and return full LoadedPlugin objects.
 *
 * Collision-detection across plugins still applies.
 */
export async function loadPluginsFull(
  pluginSpecs: string[],
  config: Config,
  logger: Logger,
): Promise<LoadedPlugin[]> {
  if (pluginSpecs.length === 0) return [];

  const loadedPlugins: LoadedPlugin[] = [];
  // Seed the collision guard with built-in tool names so a plugin can't
  // shadow a built-in (e.g. declaring prefix `git_` and registering
  // `git_status`). Without this, `registeredNames` only tracks other
  // plugins and a plugin would silently overwrite the built-in registration
  // depending on registration order.
  const registeredNames = new Set<string>(getBuiltInToolNames());

  // Deduplicate resolved paths before loading
  const seen = new Set<string>();
  const specs: string[] = [];
  for (const spec of pluginSpecs) {
    let resolved: string;
    try {
      resolved = resolvePluginDir(spec);
    } catch {
      resolved = spec;
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      specs.push(spec);
    } else {
      logger.warn(
        `Plugin "${spec}" resolves to a path already loaded — skipping duplicate`,
      );
    }
  }

  for (const spec of specs) {
    const loaded = await loadOnePluginFull(
      spec,
      config,
      logger,
      registeredNames,
    );
    if (loaded !== null) {
      loadedPlugins.push(loaded);
    }
  }

  const totalTools = loadedPlugins.reduce((n, p) => n + p.tools.length, 0);
  if (totalTools > 0) {
    logger.info(
      `Plugins loaded: ${totalTools} tool${totalTools === 1 ? "" : "s"} registered`,
    );
  }

  return loadedPlugins;
}

/**
 * Load all plugins declared in config.plugins.
 *
 * Each plugin is loaded in isolation — a failure in one plugin is logged and
 * skipped; the bridge continues with all successfully loaded plugins.
 *
 * Returns a flat list of tool registrations ready for registerAllTools().
 */
export async function loadPlugins(
  pluginSpecs: string[],
  config: Config,
  logger: Logger,
): Promise<LoadedPluginTool[]> {
  const loaded = await loadPluginsFull(pluginSpecs, config, logger);
  return loaded.flatMap((p) => p.tools);
}

export async function loadOnePluginFull(
  spec: string,
  config: Config,
  logger: Logger,
  existingNames: Set<string> = new Set(),
  isHotReload = false,
): Promise<LoadedPlugin | null> {
  // 1. Resolve directory
  let pluginDir: string;
  try {
    pluginDir = resolvePluginDir(spec);
  } catch (err) {
    logger.warn(
      `Plugin "${spec}" — cannot resolve path: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // 2. Read & parse manifest
  const manifestPath = path.join(pluginDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    logger.warn(`Plugin "${spec}" — manifest not found at ${manifestPath}`);
    return null;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    logger.warn(
      `Plugin "${spec}" — failed to parse ${MANIFEST_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const validation = validateManifest(rawManifest, spec);
  if (!validation.ok) {
    logger.warn(`Plugin "${spec}" — invalid manifest: ${validation.reason}`);
    return null;
  }
  const manifest = validation.manifest;

  // 3. Version check
  if (
    manifest.minBridgeVersion &&
    !semverGte(BRIDGE_VERSION, manifest.minBridgeVersion)
  ) {
    logger.warn(
      `Plugin "${manifest.name}" — requires bridge >= ${manifest.minBridgeVersion}, running ${BRIDGE_VERSION} (loading anyway)`,
    );
  }

  // 4. Log startup info
  const desc = manifest.description ? ` — ${manifest.description}` : "";
  const perms =
    manifest.permissions && manifest.permissions.length > 0
      ? ` [permissions: ${manifest.permissions.join(", ")}]`
      : "";
  logger.info(
    `Loading plugin "${manifest.name}"${manifest.version ? ` v${manifest.version}` : ""}${desc}${perms}`,
  );

  // 5. Dynamic import
  const entrypointPath = path.resolve(pluginDir, manifest.entrypoint);

  // Prevent entrypoint path traversal. We compare the *real* paths (after
  // symlink resolution) so a symlinked entrypoint or a symlinked pluginDir
  // can't escape lexically while pointing at attacker-controlled code
  // outside the directory. `path.relative` alone is fooled by symlinks.
  let realPluginDir: string;
  let realEntrypoint: string;
  try {
    realPluginDir = fs.realpathSync(pluginDir);
    realEntrypoint = fs.realpathSync(entrypointPath);
  } catch (err) {
    logger.warn(
      `Plugin "${manifest.name}" — failed to resolve real path for entrypoint or plugin dir: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const escapesLexically = path
    .relative(pluginDir, entrypointPath)
    .startsWith("..");
  const escapesViaSymlink = path
    .relative(realPluginDir, realEntrypoint)
    .startsWith("..");
  if (escapesLexically || escapesViaSymlink) {
    logger.warn(
      `Plugin "${manifest.name}" — entrypoint path "${manifest.entrypoint}" escapes plugin directory (resolved to ${realEntrypoint})`,
    );
    return null;
  }

  let mod: unknown;
  const ext = path.extname(entrypointPath).toLowerCase();
  const isCjs =
    ext === ".cjs" ||
    (ext === ".js" &&
      (() => {
        // Detect CJS by reading the nearest package.json "type" field.
        // A .js file is CJS unless "type": "module" is set.
        try {
          let dir = path.dirname(entrypointPath);
          while (true) {
            const pkgPath = path.join(dir, "package.json");
            if (fs.existsSync(pkgPath)) {
              const pkg = JSON.parse(
                fs.readFileSync(pkgPath, "utf-8"),
              ) as Record<string, unknown>;
              return pkg.type !== "module";
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
        } catch {
          // Can't determine — assume ESM for safety (won't break ESM plugins)
        }
        return true; // default: CJS if no "type": "module" found
      })());

  try {
    if (isCjs) {
      // For CJS plugins, use createRequire + delete require.cache for reliable hot-reload.
      // The ESM ?t= query-string approach doesn't work for CJS modules loaded via require().
      const req = createRequire(entrypointPath);
      // Invalidate the module and all its CJS children from the require cache
      const visited = new Set<string>();
      function invalidateCjsCache(modPath: string): void {
        if (visited.has(modPath)) return;
        visited.add(modPath);
        const cached = req.cache?.[modPath];
        if (cached) {
          // Recurse into children before deleting the parent
          for (const child of cached.children ?? []) {
            invalidateCjsCache(child.filename);
          }
          delete req.cache?.[modPath];
        }
      }
      try {
        invalidateCjsCache(require.resolve(entrypointPath));
      } catch {
        // resolve may fail if not yet loaded — that's fine, just load fresh
      }
      mod = req(entrypointPath);
    } else {
      // For ESM (.mjs or .js with "type": "module"), append a timestamp query string
      // to attempt cache-busting. Note: Node's ESM loader may not honour query strings
      // in all versions — this is a best-effort approach. Plugins should avoid top-level
      // mutable state if hot-reload correctness is required.
      const importUrl = `${pathToFileURL(entrypointPath).href}?t=${Date.now()}`;
      if (isHotReload) {
        logger.warn(
          `Plugin "${manifest.name}" — ESM hot-reload uses query-string cache busting, which may ` +
            `not be fully reliable in all Node versions. Avoid top-level mutable state for correct hot-reload behaviour.`,
        );
      }
      mod = await import(importUrl);
    }
  } catch (err) {
    logger.warn(
      `Plugin "${manifest.name}" — failed to import ${entrypointPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Accept either default export or named `register` export
  const registerFn =
    (mod as Record<string, unknown>).register ??
    (mod as Record<string, unknown>).default;
  if (typeof registerFn !== "function") {
    logger.warn(
      `Plugin "${manifest.name}" — entrypoint must export a "register" function (or default export)`,
    );
    return null;
  }

  // 6. Build context
  const safeConfig = {
    workspace: config.workspace,
    workspaceFolders: config.workspaceFolders,
    commandTimeout: config.commandTimeout,
    maxResultSize: config.maxResultSize,
  };

  const pluginLogger: import("./plugin.js").PluginLogger = {
    info: (msg, data) => logger.info(`[plugin:${manifest.name}] ${msg}`, data),
    warn: (msg, data) => logger.warn(`[plugin:${manifest.name}] ${msg}`, data),
    error: (msg, data) =>
      logger.error(`[plugin:${manifest.name}] ${msg}`, data),
    debug: (msg, data) =>
      logger.debug(`[plugin:${manifest.name}] ${msg}`, data),
  };

  const context: PluginContext = {
    workspace: config.workspace,
    workspaceFolders: config.workspaceFolders,
    config: safeConfig,
    logger: pluginLogger,
  };

  // 7. Call register()
  let registration: PluginRegistration;
  try {
    registration = await (registerFn as PluginRegisterFn)(context);
  } catch (err) {
    logger.warn(
      `Plugin "${manifest.name}" — register() threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (
    typeof registration !== "object" ||
    registration === null ||
    !Array.isArray(registration.tools)
  ) {
    logger.warn(
      `Plugin "${manifest.name}" — register() must return { tools: [...] }`,
    );
    return null;
  }

  if (registration.tools.length === 0) {
    logger.warn(`Plugin "${manifest.name}" — registered 0 tools`);
    return { spec, pluginDir, manifest, tools: [] };
  }

  if (registration.tools.length > MAX_TOOLS_PER_PLUGIN) {
    logger.warn(
      `Plugin "${manifest.name}" — too many tools (${registration.tools.length} > ${MAX_TOOLS_PER_PLUGIN}); skipping plugin`,
    );
    return null;
  }

  // 8. Validate tool names against prefix and collision
  const pluginToolNames: string[] = [];
  for (const t of registration.tools as PluginToolRegistration[]) {
    const name = t.schema?.name;
    if (typeof name !== "string" || !/^[a-zA-Z0-9_]+$/.test(name)) {
      logger.warn(
        `Plugin "${manifest.name}" — tool has invalid name "${String(name)}"; rejecting plugin`,
      );
      return null;
    }
    if (!name.startsWith(manifest.toolNamePrefix)) {
      logger.warn(
        `Plugin "${manifest.name}" — tool "${name}" does not start with declared prefix "${manifest.toolNamePrefix}"; rejecting plugin`,
      );
      return null;
    }
    if (existingNames.has(name) || pluginToolNames.includes(name)) {
      logger.warn(
        `Plugin "${manifest.name}" — tool name "${name}" collides with an already-registered tool; rejecting plugin`,
      );
      return null;
    }
    pluginToolNames.push(name);
  }

  // 9. Build final tool list
  const tools: LoadedPluginTool[] = (
    registration.tools as PluginToolRegistration[]
  ).map((t) => ({
    schema: t.schema as ToolSchema,
    handler: t.handler as ToolHandler,
    timeoutMs: t.timeoutMs,
  }));

  logger.info(
    `Plugin "${manifest.name}" — ${tools.length} tool${tools.length === 1 ? "" : "s"} registered: ${tools.map((t) => t.schema.name).join(", ")}`,
  );

  // Update existingNames synchronously before returning so the next plugin
  // sees these names as already registered during its collision check.
  for (const t of tools) existingNames.add(t.schema.name);

  return { spec, pluginDir, manifest, tools };
}
