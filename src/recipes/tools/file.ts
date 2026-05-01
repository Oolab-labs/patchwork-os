/**
 * File tools — file.read, file.write, file.append
 *
 * Self-registering tool module for the recipe tool registry.
 *
 * Path containment is enforced via `resolveRecipePath` (see
 * `../resolveRecipePath.ts`) — every path passed in by a recipe is
 * normalized, symlink-resolved, and asserted inside the recipe jail
 * roots before any FS call. Closes G-security F-01 / F-02 / F-10 + R2
 * C-1.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertWriteAllowed } from "../../featureFlags.js";
import { resolveRecipePath } from "../resolveRecipePath.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

function jailedPath(p: string, workspace: string, write: boolean): string {
  return resolveRecipePath(p, { workspace, write });
}

function ensureDir(p: string): void {
  const dir = dirname(p);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// file.read
// ============================================================================

registerTool({
  id: "file.read",
  namespace: "file",
  description:
    "Read file content into context. Supports optional flag to allow missing files.",
  paramsSchema: {
    type: "object",
    properties: {
      path: CommonSchemas.filePath,
      optional: CommonSchemas.optional,
      into: CommonSchemas.into,
    },
    required: ["path"],
  },
  outputSchema: {
    type: "string",
    description: "File content as string (or empty if optional and missing)",
  },
  riskDefault: "low",
  isWrite: false,
  execute: async ({ params, step, deps }) => {
    const p = jailedPath(params.path as string, deps.workdir, false);
    const optional = (step.optional as boolean) ?? false;
    try {
      return deps.readFile(p);
    } catch {
      if (optional) return "";
      throw new Error(`file.read: could not read ${p}`);
    }
  },
});

// ============================================================================
// file.write
// ============================================================================

registerTool({
  id: "file.write",
  namespace: "file",
  description: "Write content to a file path (creates directories as needed).",
  paramsSchema: {
    type: "object",
    properties: {
      path: CommonSchemas.filePath,
      content: {
        type: "string",
        description: "Content to write (supports {{template}} substitution)",
      },
      into: CommonSchemas.into,
    },
    required: ["path", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      bytesWritten: { type: "number" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  execute: async ({ params, deps }) => {
    assertWriteAllowed("file.write");
    const p = jailedPath(params.path as string, deps.workdir, true);
    const content = params.content as string;
    ensureDir(p);
    deps.writeFile(p, content);
    return JSON.stringify({ path: p, bytesWritten: content.length });
  },
});

// ============================================================================
// file.append
// ============================================================================

registerTool({
  id: "file.append",
  namespace: "file",
  description:
    "Append content to a file (creates if missing). Supports conditional 'when' clause.",
  paramsSchema: {
    type: "object",
    properties: {
      path: CommonSchemas.filePath,
      content: {
        type: "string",
        description: "Content to append (supports {{template}} substitution)",
      },
      when: CommonSchemas.when,
      into: CommonSchemas.into,
    },
    required: ["path", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      bytesAppended: { type: "number" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  execute: async ({ params, step, deps }) => {
    assertWriteAllowed("file.append");
    const p = jailedPath(params.path as string, deps.workdir, true);
    const content = params.content as string;
    // 'when' condition is evaluated before executeStep is called in yamlRunner
    // but we check here too for direct registry usage
    const when = step.when as string | undefined;
    if (when && !evalCondition(when, {})) {
      return null;
    }
    ensureDir(p);
    deps.appendFile(p, content);
    return JSON.stringify({ path: p, bytesAppended: content.length });
  },
});

/**
 * Minimal condition evaluator for 'when' clauses.
 * Note: yamlRunner.ts has a more complete evalWhen that runs before executeStep.
 * This is a fallback for direct registry usage.
 */
function evalCondition(expr: string, _ctx: Record<string, unknown>): boolean {
  // Simple numeric comparisons: "N > 0"
  const match = expr.match(/^\s*(\w+)\s*([><=!]+)\s*(\d+)\s*$/);
  if (match) {
    const [, _var, op, val] = match;
    if (!op || !val) return false;
    const num = 0; // Would resolve from ctx in full implementation
    const cmp = parseInt(val, 10);
    switch (op) {
      case ">":
        return num > cmp;
      case ">=":
        return num >= cmp;
      case "<":
        return num < cmp;
      case "<=":
        return num <= cmp;
      case "==":
        return num === cmp;
      case "!=":
        return num !== cmp;
    }
  }
  // Default: evaluate truthy
  return expr.length > 0;
}
