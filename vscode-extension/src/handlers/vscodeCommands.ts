import * as vscode from "vscode";
import { MAX_COMMANDS } from "../constants";

export async function handleExecuteVSCodeCommand(
  params: Record<string, unknown>,
): Promise<unknown> {
  const command = params.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("command is required and must be a non-empty string");
  }
  const args = Array.isArray(params.args) ? params.args : [];

  let result: unknown;
  try {
    result = await vscode.commands.executeCommand(command, ...args);
  } catch (err) {
    throw new Error(
      `Command "${command}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Safely serialize result — guard against circular references
  let serialized: unknown;
  try {
    serialized = JSON.parse(JSON.stringify(result ?? null));
  } catch {
    serialized = String(result);
  }
  return { result: serialized };
}

export async function handleListVSCodeCommands(
  params: Record<string, unknown>,
): Promise<unknown> {
  const filter =
    typeof params.filter === "string" ? params.filter.toLowerCase() : undefined;
  const all = await vscode.commands.getCommands(true); // filterInternal=true to exclude _internal
  let filtered = all;
  if (filter) {
    filtered = all.filter((cmd) => cmd.toLowerCase().includes(filter));
  }
  const commands = filtered.slice(0, MAX_COMMANDS);
  return {
    commands,
    total: filtered.length,
    capped: filtered.length > MAX_COMMANDS,
  };
}
