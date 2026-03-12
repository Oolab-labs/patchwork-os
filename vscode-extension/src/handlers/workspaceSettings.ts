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
