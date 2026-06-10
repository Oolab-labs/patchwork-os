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
    return JSON.stringify({
      path: p,
      bytesWritten: Buffer.byteLength(content, "utf8"),
    });
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
  execute: async ({ params, step, ctx, deps }) => {
    assertWriteAllowed("file.append");
    const p = jailedPath(params.path as string, deps.workdir, true);
    const content = params.content as string;
    // 'when' is evaluated by both runners before executeStep is called
    // (yamlRunner.ts step loop + chainedRunner.ts:248-266). This in-tool
    // fallback only runs when the registry is invoked directly (no runner),
    // and uses the limited evalCondition below — runner paths render the
    // template against the recipe's context first, which this fallback can't.
    // Pass the run context so a `var > N` guard can resolve `var` against
    // prior step outputs / vars instead of the old hard-coded 0.
    const when = step.when as string | undefined;
    if (when && !evalCondition(when, (ctx ?? {}) as Record<string, unknown>)) {
      return null;
    }
    ensureDir(p);
    deps.appendFile(p, content);
    return JSON.stringify({
      path: p,
      bytesAppended: Buffer.byteLength(content, "utf8"),
    });
  },
});

/**
 * Minimal condition evaluator for 'when' clauses.
 * Note: yamlRunner.ts has a more complete evalWhen that runs before executeStep.
 * This is a fallback for direct registry usage.
 */
function evalCondition(expr: string, ctx: Record<string, unknown>): boolean {
  // Simple numeric comparisons: "N > 0"
  const match = expr.match(/^\s*(\w+)\s*([><=!]+)\s*(\d+)\s*$/);
  if (match) {
    const [, varName, op, val] = match;
    if (!op || !val || !varName) return false;
    // Resolve the left-hand variable from the supplied context. The previous
    // implementation hard-coded `num = 0`, so every `var > N` (N > 0) was
    // permanently false and every `var <= N` permanently true regardless of
    // the actual value. Look the variable up (own-property only, no prototype
    // walk) and coerce to a finite number; absent/non-numeric resolves to 0.
    const raw = Object.hasOwn(ctx, varName) ? ctx[varName] : undefined;
    const num = typeof raw === "number" ? raw : Number(raw);
    const resolved = Number.isFinite(num) ? num : 0;
    const cmp = parseInt(val, 10);
    return compareNumbers(resolved, op, cmp);
  }
  // Default: evaluate truthy
  return expr.length > 0;
}

/** Apply a comparison operator to two numbers; unknown operators are false. */
function compareNumbers(num: number, op: string, cmp: number): boolean {
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
    default:
      return false;
  }
}
