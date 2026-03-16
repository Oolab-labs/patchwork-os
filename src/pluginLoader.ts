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
import type {
  PluginContext,
  PluginManifest,
  PluginRegisterFn,
  PluginRegistration,
  PluginToolRegistration,
} from "./plugin.js";
import type { ToolHandler, ToolSchema } from "./transport.js";

const MANIFEST_FILE = "claude-ide-bridge-plugin.json";
const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_TOOLS_PER_PLUGIN = 100;

/** Compiled package version — compared against minBridgeVersion. */
const BRIDGE_VERSION = "2.1.23";

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
  const registeredNames = new Set<string>(); // collision guard across plugins

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

  // Prevent entrypoint path traversal — the resolved path must stay inside pluginDir
  if (path.relative(pluginDir, entrypointPath).startsWith("..")) {
    logger.warn(
      `Plugin "${manifest.name}" — entrypoint path "${manifest.entrypoint}" escapes plugin directory (resolved to ${entrypointPath})`,
    );
    return null;
  }

  let mod: unknown;
  try {
    const importUrl = `${pathToFileURL(entrypointPath).href}?t=${Date.now()}`;
    mod = await import(importUrl);
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
