import * as vscode from "vscode";

// Keys (or key prefixes) that must never be written by an agent.
// Matching is done against the full key and all its prefixes, so listing
// "extensions.autoUpdate" blocks both the exact key and any sub-key under it.
const BLOCKED_KEY_PREFIXES = new Set([
  "security",
  "extensions.autoUpdate",
  "extensions.autoInstallDependencies",
  // Terminal shell hijacking — writing these allows arbitrary code execution
  // via the shell that VS Code opens for integrated terminals.
  "terminal.integrated.shell",
  "terminal.integrated.shellArgs",
  "terminal.integrated.env",
  "terminal.integrated.profiles",
  "terminal.integrated.defaultProfile",
]);

// Plain-object check that excludes arrays and null. Used to decide whether a
// setting value carries nested leaf keys we need to vet against the blocklist.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively enumerate the dotted leaf paths of a plain object. Arrays and
// primitive values terminate a branch; only nested plain objects recurse, since
// VS Code settings keys are dotted object paths.
function enumerateLeafPaths(value: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const segment of Object.keys(value)) {
    // Skip prototype-polluting keys; they're rejected separately.
    if (
      segment === "__proto__" ||
      segment === "constructor" ||
      segment === "prototype"
    ) {
      paths.push(segment);
      continue;
    }
    const child = value[segment];
    if (isPlainObject(child)) {
      const childPaths = enumerateLeafPaths(child);
      if (childPaths.length === 0) {
        paths.push(segment);
      } else {
        for (const childPath of childPaths) {
          paths.push(`${segment}.${childPath}`);
        }
      }
    } else {
      paths.push(segment);
    }
  }
  return paths;
}

export async function handleGetWorkspaceSettings(
  params: Record<string, unknown>,
): Promise<unknown> {
  const section =
    typeof params.section === "string" ? params.section : undefined;
  const config = vscode.workspace.getConfiguration(section);

  // Get the raw configuration object
  const result: Record<string, unknown> = {};
  // Iterate over known keys via inspect
  const rawConfig = config as unknown as { [key: string]: unknown };
  for (const key of Object.keys(rawConfig)) {
    if (key.startsWith("_") || typeof rawConfig[key] === "function") continue;
    const inspection = config.inspect(key);
    if (inspection !== undefined) {
      result[key] = {
        value: config.get(key),
        defaultValue: inspection.defaultValue,
        globalValue: inspection.globalValue,
        workspaceValue: inspection.workspaceValue,
        workspaceFolderValue: inspection.workspaceFolderValue,
      };
    }
  }
  return { section: section ?? "(root)", settings: result };
}

export async function handleSetWorkspaceSetting(
  params: Record<string, unknown>,
): Promise<unknown> {
  const key = params.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("key is required and must be a non-empty string");
  }
  const value = params.value;
  const targetStr =
    typeof params.target === "string" ? params.target : "workspace";

  // Block writes to sensitive keys and their sub-keys.
  // Check every prefix segment so "terminal.integrated.shell.linux" is caught
  // by the "terminal.integrated.shell" entry.
  const isBlocked = [...BLOCKED_KEY_PREFIXES].some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`),
  );
  if (isBlocked) {
    throw new Error(`Writing to "${key}" settings is blocked for safety`);
  }

  // Shell-hijack bypass guard. config.update(section, value) writes value into
  // the section, so an agent can target an ANCESTOR of a blocked prefix
  // (e.g. key="terminal.integrated") and smuggle blocked leaf keys via a nested
  // object value, sidestepping the exact/sub-key match above. When the key is
  // an ancestor of a blocked prefix:
  //   - If value is a plain object, enumerate its leaf paths and reject only
  //     when a resolved path lands on a blocked prefix — legitimate unrelated
  //     writes to the same section still succeed.
  //   - Otherwise (non-object value), we can't introspect leaves, so block the
  //     write outright: there is no legitimate reason to overwrite a whole
  //     security-sensitive section with a scalar.
  const keyIsAncestorOfBlocked = [...BLOCKED_KEY_PREFIXES].some((prefix) =>
    prefix.startsWith(`${key}.`),
  );
  if (isPlainObject(value)) {
    for (const leafPath of enumerateLeafPaths(value)) {
      const resolved = `${key}.${leafPath}`;
      const leafBlocked = [...BLOCKED_KEY_PREFIXES].some(
        (prefix) => resolved === prefix || resolved.startsWith(`${prefix}.`),
      );
      if (leafBlocked) {
        throw new Error(
          `Writing to "${resolved}" settings is blocked for safety`,
        );
      }
    }
  } else if (keyIsAncestorOfBlocked) {
    throw new Error(`Writing to "${key}" settings is blocked for safety`);
  }

  // Defend against prototype pollution via keys like __proto__ or constructor
  if (/^(__proto__|constructor|prototype)(\.|$)/.test(key)) {
    throw new Error(`Writing to "${key}" settings is blocked for safety`);
  }

  const target =
    targetStr === "global"
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;

  // Determine the section and setting name
  const lastDot = key.lastIndexOf(".");
  const section = lastDot > -1 ? key.slice(0, lastDot) : undefined;
  const settingKey = lastDot > -1 ? key.slice(lastDot + 1) : key;

  const config = vscode.workspace.getConfiguration(section);
  await config.update(settingKey, value, target);
  return { set: true, key, target: targetStr };
}
