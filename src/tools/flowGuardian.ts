import fsp from "node:fs/promises";
import path from "node:path";
import {
  requireString,
  optionalString,
  resolveFilePath,
  success,
  error,
} from "./utils.js";

interface ScopeEntry {
  pattern: string;
  isDirectory: boolean;
  isGlob: boolean;
  isNegation: boolean;
}

function parseScopeSection(lines: string[]): ScopeEntry[] {
  const entries: ScopeEntry[] = [];
  for (const line of lines) {
    const match = line.match(/^- (.+)/);
    if (!match) continue;
    let pattern = match[1]!.trim();
    if (!pattern) continue;
    const isNegation = pattern.startsWith("!");
    if (isNegation) pattern = pattern.slice(1);
    entries.push({
      pattern,
      isDirectory: pattern.endsWith("/"),
      isGlob: pattern.includes("*"),
      isNegation,
    });
  }
  return entries;
}

function matchesScopeEntry(relativePath: string, entry: ScopeEntry): boolean {
  if (entry.isGlob) return matchesGlob(relativePath, entry.pattern);
  if (entry.isDirectory) {
    return (
      relativePath.startsWith(entry.pattern) ||
      relativePath.startsWith(entry.pattern.slice(0, -1))
    );
  }
  return relativePath === entry.pattern;
}

function extractImplicitPaths(content: string): string[] {
  const paths = new Set<string>();
  // Backtick-wrapped paths
  const backtickRegex = /`([\w./-]+(?:\.\w+)?)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRegex.exec(content)) !== null) {
    const p = m[1]!;
    if (p.includes("/") || p.includes(".")) paths.add(p);
  }
  // Bare path-like mentions (word/word.ext or word/word/)
  const bareRegex = /(?:^|\s)((?:[\w-]+\/)+[\w.-]+)/gm;
  while ((m = bareRegex.exec(content)) !== null) {
    paths.add(m[1]!);
  }
  return [...paths];
}

function matchesGlob(filePath: string, pattern: string): boolean {
  // Guard against ReDoS: reject overly complex patterns
  if (pattern.length > 200) return false;
  if ((pattern.match(/\*/g) || []).length > 10) return false;

  // Collapse consecutive * (same fix as minimatch 10.2.1 for CVE-2026-27904)
  const collapsed = pattern.replace(/\*{3,}/g, "**");

  // Simple glob matching: ** matches any path segments, * matches within segment
  const regexStr = collapsed
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}

export function createCheckScopeTool(workspace: string) {
  return {
    schema: {
      name: "checkScope",
      description:
        "Check whether a file path and operation are in-scope for the active plan (.claude-plan.md). Advisory only — returns scope status and suggested action.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string",
            description:
              "File path to check (absolute or relative to workspace)",
          },
          operation: {
            type: "string",
            enum: ["read", "write", "delete", "create"],
            description: "Type of operation being considered. Default: 'write'",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const rawPath = requireString(args, "filePath");
      const operation = optionalString(args, "operation") ?? "write";
      const resolved = resolveFilePath(rawPath, workspace);
      const relativePath = path.relative(workspace, resolved);

      // Try to read the plan file
      const planPath = path.join(workspace, ".claude-plan.md");
      if (!(await fsp.access(planPath).then(() => true, () => false))) {
        return success({
          planFound: false,
          inScope: true,
          reason: "No active plan found — all operations permitted",
          suggestedAction: "proceed",
          scopeSection: false,
        });
      }

      const content = await fsp.readFile(planPath, "utf-8");

      // Read operations are always in scope
      if (operation === "read") {
        return success({
          planFound: true,
          inScope: true,
          reason: "Read operations are always in scope",
          suggestedAction: "proceed",
          scopeSection: false,
        });
      }

      // Parse ## Scope section
      const lines = content.split("\n");
      let inScopeSection = false;
      const scopeLines: string[] = [];
      for (const line of lines) {
        if (line.match(/^## Scope/i)) {
          inScopeSection = true;
          continue;
        }
        if (inScopeSection && line.match(/^## /)) break;
        if (inScopeSection) scopeLines.push(line);
      }

      const hasExplicitScope = scopeLines.length > 0;
      const scopeEntries = parseScopeSection(scopeLines);
      const implicitPaths = extractImplicitPaths(content);

      // Check explicit scope entries
      if (hasExplicitScope) {
        // Check negations first — if a negation matches, block immediately
        for (const entry of scopeEntries) {
          if (entry.isNegation && matchesScopeEntry(relativePath, entry)) {
            return success({
              planFound: true,
              inScope: false,
              reason: `Excluded by negation pattern: !${entry.pattern}`,
              suggestedAction: "block",
              scopeSection: true,
            });
          }
        }

        // Check positive scope entries
        for (const entry of scopeEntries) {
          if (entry.isNegation) continue;
          if (matchesScopeEntry(relativePath, entry)) {
            const reason = entry.isGlob
              ? `Matches scope glob pattern: ${entry.pattern}`
              : entry.isDirectory
                ? `Within scoped directory: ${entry.pattern}`
                : `Exact match in scope: ${entry.pattern}`;
            return success({
              planFound: true,
              inScope: true,
              reason,
              suggestedAction: "proceed",
              scopeSection: true,
            });
          }
        }

        // Check if it's in a mentioned directory but not explicitly scoped
        for (const p of implicitPaths) {
          if (relativePath === p || relativePath.startsWith(p + "/")) {
            return success({
              planFound: true,
              inScope: true,
              reason: `Mentioned in plan body but not in explicit Scope section: ${p}`,
              suggestedAction: "warn",
              scopeSection: true,
            });
          }
        }

        const positiveEntries = scopeEntries.filter((e) => !e.isNegation);
        return success({
          planFound: true,
          inScope: false,
          reason: `Not matched by any Scope entry. Scoped to: ${positiveEntries.map((e) => e.pattern).join(", ")}`,
          suggestedAction: "block",
          scopeSection: true,
        });
      }

      // No explicit scope — use implicit mentions
      for (const p of implicitPaths) {
        if (relativePath === p || relativePath.startsWith(p + "/")) {
          return success({
            planFound: true,
            inScope: true,
            reason: `Mentioned in plan: ${p}`,
            suggestedAction: "proceed",
            scopeSection: false,
          });
        }
      }

      // Check if any implicit path shares a directory prefix
      const relativeDir = path.dirname(relativePath);
      for (const p of implicitPaths) {
        const pDir = path.dirname(p);
        if (relativeDir === pDir || relativeDir.startsWith(pDir + "/")) {
          return success({
            planFound: true,
            inScope: true,
            reason: `In same directory as plan-mentioned file: ${p}`,
            suggestedAction: "proceed",
            scopeSection: false,
          });
        }
      }

      return success({
        planFound: true,
        inScope: false,
        reason: "File not mentioned in plan",
        suggestedAction: "warn",
        scopeSection: false,
      });
    },
  };
}

export function createExpandScopeTool(workspace: string) {
  return {
    schema: {
      name: "expandScope",
      description:
        "Add entries to the ## Scope section of the active plan (.claude-plan.md). Creates the section if it doesn't exist.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["entries"],
        properties: {
          entries: {
            type: "array",
            items: { type: "string" },
            description:
              "Scope entries to add (e.g., 'src/utils/', '!dist/', '**/*.test.ts')",
          },
          fileName: {
            type: "string",
            description: "Plan filename (default: .claude-plan.md)",
          },
        },
        additionalProperties: false as const,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const rawEntries = args.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        return error("entries must be a non-empty array of strings");
      }
      if (rawEntries.length > 100) {
        return error("Maximum 100 scope entries allowed at once");
      }
      const entries = rawEntries
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.replace(/[\n\r]/g, "").trim())
        .filter((e) => e.length > 0 && e.length <= 200);
      if (entries.length === 0) {
        return error("No valid entries provided");
      }

      const fileName =
        optionalString(args, "fileName") ?? ".claude-plan.md";
      const planPath = resolveFilePath(fileName, workspace);

      if (!(await fsp.access(planPath).then(() => true, () => false))) {
        return error(
          `Plan file "${fileName}" not found. Use createPlan to create one.`,
        );
      }

      const content = await fsp.readFile(planPath, "utf-8");
      const lines = content.split("\n");

      // Find ## Scope section
      let scopeStart = -1;
      let scopeEnd = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.match(/^## Scope/i)) {
          scopeStart = i;
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j]!.match(/^## /)) {
              scopeEnd = j;
              break;
            }
          }
          break;
        }
      }

      const newLines = entries.map((e) => `- ${e.trim()}`);

      if (scopeStart === -1) {
        // No Scope section — insert after frontmatter
        let insertAt = 0;
        if (lines[0]?.trim() === "---") {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i]?.trim() === "---") {
              insertAt = i + 1;
              break;
            }
          }
        }
        const section = ["", "## Scope", "", ...newLines, ""];
        lines.splice(insertAt, 0, ...section);
      } else {
        // Insert before the next section (or end)
        lines.splice(scopeEnd, 0, ...newLines);
      }

      await fsp.writeFile(planPath, lines.join("\n"), "utf-8");

      return success({
        expanded: true,
        entriesAdded: entries.length,
        entries,
      });
    },
  };
}
