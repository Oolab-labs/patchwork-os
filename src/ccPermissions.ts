import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code permission rule reader.
 *
 * Respects CC's `deny → ask → allow` precedence. See
 * https://code.claude.com/docs/en/permissions
 *
 * Reads from the documented settings precedence:
 *   1. managed (can't be overridden) — not implemented here; CC-only path
 *   2. local project (.claude/settings.local.json)
 *   3. shared project (.claude/settings.json)
 *   4. user (~/.claude/settings.json)
 *
 * `deny` at any level is final. For `allow`, any level grants.
 */

export type Decision = "allow" | "ask" | "deny";

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface SettingsFile {
  permissions?: Partial<PermissionRules>;
}

export function loadCcPermissions(
  workspace: string,
  deps: {
    readFile?: (p: string) => string;
    exists?: (p: string) => boolean;
  } = {},
): PermissionRules {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const ex = deps.exists ?? existsSync;

  const paths = [
    join(workspace, ".claude", "settings.local.json"),
    join(workspace, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];

  const merged: PermissionRules = { allow: [], ask: [], deny: [] };
  for (const p of paths) {
    if (!ex(p)) continue;
    try {
      const parsed = JSON.parse(read(p)) as SettingsFile;
      const r = parsed.permissions ?? {};
      if (Array.isArray(r.allow)) merged.allow.push(...r.allow);
      if (Array.isArray(r.ask)) merged.ask.push(...r.ask);
      if (Array.isArray(r.deny)) merged.deny.push(...r.deny);
    } catch {
      // silently skip — malformed settings shouldn't block the bridge
    }
  }
  return merged;
}

/**
 * Classify a tool call against CC rules. Rule matching is minimal — it
 * covers the common cases needed to avoid re-prompting:
 *   - Tool name only (e.g. "Read", "WebFetch")
 *   - Tool(specifier) exact match
 *   - `:*` or trailing ` *` wildcard on Bash/WebFetch specifier
 *
 * Full gitignore-style Read/Edit pattern matching is out of scope here;
 * CC itself handles those inside its own runtime.
 */
export function evaluateRules(
  toolName: string,
  specifier: string | undefined,
  rules: PermissionRules,
): Decision | "none" {
  if (anyMatch(toolName, specifier, rules.deny)) return "deny";
  if (anyMatch(toolName, specifier, rules.ask)) return "ask";
  if (anyMatch(toolName, specifier, rules.allow)) return "allow";
  return "none";
}

function anyMatch(
  toolName: string,
  specifier: string | undefined,
  patterns: string[],
): boolean {
  for (const pat of patterns) {
    if (matchRule(toolName, specifier, pat)) return true;
  }
  return false;
}

function matchRule(
  toolName: string,
  specifier: string | undefined,
  rule: string,
): boolean {
  // Tool-name-only rule
  if (!rule.includes("(")) return rule === toolName;

  const open = rule.indexOf("(");
  const close = rule.lastIndexOf(")");
  if (close === -1) return false;
  const tool = rule.slice(0, open);
  const pat = rule.slice(open + 1, close);
  if (tool !== toolName) return false;
  if (!specifier) return pat === "" || pat === "*" || pat === ":*";

  // wildcard forms
  if (pat === "*" || pat === ":*") return true;
  if (pat.endsWith(":*")) {
    const prefix = pat.slice(0, -2);
    return specifier === prefix || specifier.startsWith(`${prefix} `);
  }
  if (pat.endsWith(" *")) {
    const prefix = pat.slice(0, -2);
    return specifier === prefix || specifier.startsWith(`${prefix} `);
  }
  if (pat.startsWith("* ")) {
    return specifier.endsWith(pat.slice(1));
  }
  return pat === specifier;
}
