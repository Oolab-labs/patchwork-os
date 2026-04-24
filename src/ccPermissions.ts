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

export type RuleSource = "managed" | "project-local" | "project" | "user";

export interface AttributedRule {
  pattern: string;
  source: RuleSource;
}

export interface AttributedPermissionRules {
  allow: AttributedRule[];
  ask: AttributedRule[];
  deny: AttributedRule[];
}

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface SettingsFile {
  permissions?: Partial<PermissionRules>;
}

export interface LoadCcPermissionsDeps {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  /** Path to a managed settings file (highest precedence, cannot be overridden). */
  managedPath?: string;
}

export function loadCcPermissions(
  workspace: string,
  deps: LoadCcPermissionsDeps = {},
): PermissionRules {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const ex = deps.exists ?? existsSync;

  // Managed path (if provided) is prepended — its deny rules are absolute
  // because deny already wins over all other layers in evaluateRules.
  const paths = [
    ...(deps.managedPath ? [deps.managedPath] : []),
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
 * Like loadCcPermissions but tags each rule with its originating source file
 * so the dashboard can render per-rule attribution badges.
 */
export function loadCcPermissionsAttributed(
  workspace: string,
  deps: LoadCcPermissionsDeps = {},
): AttributedPermissionRules {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const ex = deps.exists ?? existsSync;

  const sources: Array<{ path: string; source: RuleSource }> = [
    ...(deps.managedPath
      ? [{ path: deps.managedPath, source: "managed" as RuleSource }]
      : []),
    {
      path: join(workspace, ".claude", "settings.local.json"),
      source: "project-local" as RuleSource,
    },
    {
      path: join(workspace, ".claude", "settings.json"),
      source: "project" as RuleSource,
    },
    {
      path: join(homedir(), ".claude", "settings.json"),
      source: "user" as RuleSource,
    },
  ];

  const merged: AttributedPermissionRules = { allow: [], ask: [], deny: [] };
  for (const { path: p, source } of sources) {
    if (!ex(p)) continue;
    try {
      const parsed = JSON.parse(read(p)) as SettingsFile;
      const r = parsed.permissions ?? {};
      if (Array.isArray(r.allow))
        merged.allow.push(...r.allow.map((pattern) => ({ pattern, source })));
      if (Array.isArray(r.ask))
        merged.ask.push(...r.ask.map((pattern) => ({ pattern, source })));
      if (Array.isArray(r.deny))
        merged.deny.push(...r.deny.map((pattern) => ({ pattern, source })));
    } catch {
      // silently skip — malformed settings shouldn't block the bridge
    }
  }
  return merged;
}

/**
 * Classify a tool call against CC rules using deny → ask → allow precedence.
 *
 * Specifier patterns follow CC's glob syntax:
 *   - Tool name only:           "Read"
 *   - Exact specifier:          "Bash(git status)"
 *   - Glob specifier:           "Bash(npm run *)", "WebFetch(https://api.example.com/*)"
 *   - Legacy colon-star:        "Bash(git:*)"
 *   - Full wildcard:            "Bash(*)"
 *
 * Path-glob rules (Read/Edit with file patterns) are forwarded to allow
 * so CC's own runtime can apply the finer-grained check.
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
  // Tool-name-only rule — no specifier constraint.
  if (!rule.includes("(")) return rule === toolName;

  const open = rule.indexOf("(");
  const close = rule.lastIndexOf(")");
  if (close === -1) return false;
  const tool = rule.slice(0, open);
  const pat = rule.slice(open + 1, close);
  if (tool !== toolName) return false;

  // Full wildcard — matches any specifier (or no specifier).
  if (pat === "*") return true;

  // No specifier on call — only the bare wildcards match.
  if (!specifier) return pat === "" || pat === ":*";

  // Legacy colon-star form: "git:*" means "git" or "git <anything>".
  // Normalize to space-star so the glob engine handles it uniformly.
  const normalized = pat.endsWith(":*") ? `${pat.slice(0, -2)} *` : pat;

  return globMatch(normalized, specifier);
}

/**
 * Minimal glob matcher supporting `*` (any sequence) and `?` (any char).
 * No path semantics — `*` matches across separators, which is what CC
 * uses for command specifiers like "npm run *" or "https://example.com/*".
 */
function globMatch(pattern: string, str: string): boolean {
  // Fast path: no wildcards.
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return pattern === str;
  }

  // dp[i][j] = pattern[0..i) matches str[0..j)
  const p = pattern.length;
  const s = str.length;
  const dp = Array.from({ length: p + 1 }, () =>
    new Array<boolean>(s + 1).fill(false),
  ) as boolean[][];
  (dp[0] as boolean[])[0] = true;

  // Leading stars match empty string.
  for (let i = 1; i <= p; i++) {
    if (pattern[i - 1] === "*")
      (dp[i] as boolean[])[0] = (dp[i - 1] as boolean[])[0] ?? false;
  }

  for (let i = 1; i <= p; i++) {
    for (let j = 1; j <= s; j++) {
      if (pattern[i - 1] === "*") {
        (dp[i] as boolean[])[j] =
          ((dp[i - 1] as boolean[])[j] ?? false) ||
          ((dp[i] as boolean[])[j - 1] ?? false);
      } else if (pattern[i - 1] === "?" || pattern[i - 1] === str[j - 1]) {
        (dp[i] as boolean[])[j] = (dp[i - 1] as boolean[])[j - 1] ?? false;
      }
    }
  }

  return (dp[p] as boolean[])[s] ?? false;
}
