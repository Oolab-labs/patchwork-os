import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Register the Patchwork PreToolUse approval hook in Claude Code's
 * settings.json. Idempotent: re-running `patchwork init` doesn't duplicate
 * the entry.
 *
 * The hook command resolves to the absolute path of
 * `scripts/patchwork-approval-hook.sh` relative to the installed package.
 */

type FlatHook = { type?: string; command?: string };
type NestedHook = { matcher?: string; hooks?: FlatHook[] };
type HookEntry = NestedHook | FlatHook;

const HOOK_EVENT = "PreToolUse";
const HOOK_MARKER = "patchwork-approval-hook";

export interface RegisterResult {
  action: "added" | "already-wired" | "error";
  path: string;
  hookCommand: string;
  error?: string;
}

export function resolveHookScriptPath(baseDir?: string): string {
  // When called from dist/, src/ lives one directory up in a dev checkout
  // or two directories up in an npm install (node_modules/patchwork-os/…).
  // Resolving relative to this file's URL handles both.
  const here = baseDir ?? path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "scripts", "patchwork-approval-hook.sh");
}

export function registerPreToolUseHook(
  ccSettingsPath: string,
  opts: { hookScriptPath?: string } = {},
): RegisterResult {
  const hookScriptPath = opts.hookScriptPath ?? resolveHookScriptPath();
  const hookCommand = `bash ${quoteIfNeeded(hookScriptPath)}`;

  try {
    let ccSettings: Record<string, unknown> = {};
    if (existsSync(ccSettingsPath)) {
      ccSettings = JSON.parse(readFileSync(ccSettingsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    }
    const allHooks = (ccSettings.hooks ?? {}) as Record<string, HookEntry[]>;
    const entries = (allHooks[HOOK_EVENT] ?? []).map(normalize);
    const alreadyWired = entries.some((entry) =>
      (entry.hooks ?? []).some(
        (h) => typeof h.command === "string" && h.command.includes(HOOK_MARKER),
      ),
    );
    if (alreadyWired) {
      return { action: "already-wired", path: ccSettingsPath, hookCommand };
    }
    entries.push({
      matcher: "*",
      hooks: [{ type: "command", command: hookCommand }],
    });
    allHooks[HOOK_EVENT] = entries;
    ccSettings.hooks = allHooks;
    writeFileSync(ccSettingsPath, `${JSON.stringify(ccSettings, null, 2)}\n`);
    return { action: "added", path: ccSettingsPath, hookCommand };
  } catch (err) {
    return {
      action: "error",
      path: ccSettingsPath,
      hookCommand,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalize(e: HookEntry): NestedHook {
  if (e && Array.isArray((e as NestedHook).hooks)) {
    return {
      matcher: (e as NestedHook).matcher ?? "",
      hooks: (e as NestedHook).hooks ?? [],
    };
  }
  return { matcher: "", hooks: [e as FlatHook] };
}

function quoteIfNeeded(p: string): string {
  return /[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}
