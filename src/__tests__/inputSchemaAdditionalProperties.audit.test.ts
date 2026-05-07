import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Audit: every tool's `inputSchema` block must declare `additionalProperties`.
 *
 * Why: AJV's default is to allow extras. A schema that omits the field silently
 * accepts unknown keys, which (a) hides client bugs and (b) erodes the
 * defensive-coding posture the rest of the registry assumes (see the
 * `_meta`-strip note in transport.ts:1245-1248). The vast majority of tools
 * already set `additionalProperties: false`; this guard prevents the few
 * that don't from regressing back.
 *
 * Static check on source files — does not require building or registering
 * tools. Cheap to run, runs as part of `npm test`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(__dirname, "..", "tools");

interface Block {
  file: string;
  /** 1-based line number where the inputSchema block begins. */
  startLine: number;
  /** Raw value text for `additionalProperties` at the top of the block, or null if absent. */
  topLevelAdditionalProperties: string | null;
}

/**
 * Extract every `inputSchema: { ... }` block and find its top-level
 * `additionalProperties` value (depth 1 inside the block braces). Nested
 * `additionalProperties` inside sub-schemas (e.g. `env: { additionalProperties:
 * { type: "string" } }`) are intentionally ignored — those are JSON Schema
 * value-shape declarations, not the outer extras-policy constraint.
 */
function extractInputSchemaBlocks(file: string, source: string): Block[] {
  const out: Block[] = [];
  const marker = /\binputSchema\s*:\s*\{/g;
  let match: RegExpExecArray | null = marker.exec(source);
  while (match !== null) {
    const open = source.indexOf("{", match.index);
    const startLine = source.slice(0, match.index).split("\n").length;

    let depth = 0;
    let topLevelAdditionalProperties: string | null = null;
    for (let j = open; j < source.length; j++) {
      const ch = source[j];
      if (ch === "{") {
        // At the top of the block (depth transitions 0→1), scan ahead for
        // `additionalProperties:` keys at depth 1 only.
        depth++;
        if (depth === 1) {
          // Walk depth-1 keys until the closing brace.
          let k = j + 1;
          let innerDepth = 0;
          while (k < source.length) {
            const c = source[k];
            if (c === "{" || c === "[") innerDepth++;
            else if (c === "}" || c === "]") {
              if (innerDepth === 0) break;
              innerDepth--;
            } else if (innerDepth === 0 && c === "a") {
              const slice = source.slice(k);
              const m = slice.match(/^additionalProperties\s*:\s*([^,\n}]+)/);
              if (m) {
                topLevelAdditionalProperties = m[1]?.trim() ?? "";
                k += m[0].length;
                continue;
              }
            }
            k++;
          }
          out.push({ file, startLine, topLevelAdditionalProperties });
          // Skip to matching close so the outer loop's regex picks up the
          // next inputSchema (if any).
          let outerDepth = 1;
          let kk = j + 1;
          while (kk < source.length && outerDepth > 0) {
            if (source[kk] === "{") outerDepth++;
            else if (source[kk] === "}") outerDepth--;
            kk++;
          }
          marker.lastIndex = kk;
          break;
        }
      } else if (ch === "}") {
        depth--;
      }
    }
    match = marker.exec(source);
  }
  return out;
}

function listToolFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...listToolFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("tool inputSchema audit", () => {
  test("every inputSchema block declares top-level additionalProperties", () => {
    const offenders: string[] = [];
    for (const file of listToolFiles(toolsDir)) {
      const source = readFileSync(file, "utf8");
      const blocks = extractInputSchemaBlocks(file, source);
      for (const block of blocks) {
        if (block.topLevelAdditionalProperties === null) {
          offenders.push(
            `${path.relative(toolsDir, file)}:${block.startLine} — missing top-level additionalProperties`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every inputSchema block sets top-level additionalProperties to false", () => {
    // Output schemas may legitimately set true (third-party LSP responses,
    // user settings shapes, etc.), but input schemas must be strict.
    const offenders: string[] = [];
    for (const file of listToolFiles(toolsDir)) {
      const source = readFileSync(file, "utf8");
      const blocks = extractInputSchemaBlocks(file, source);
      for (const block of blocks) {
        const value = block.topLevelAdditionalProperties;
        if (value === null) continue; // covered by the previous test
        const isFalse = /^false(\s+as\s+const)?$/.test(value);
        if (!isFalse) {
          offenders.push(
            `${path.relative(toolsDir, file)}:${block.startLine} — additionalProperties is "${value}", expected false`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("audit finds at least one inputSchema (sanity check)", () => {
    let total = 0;
    for (const file of listToolFiles(toolsDir)) {
      const source = readFileSync(file, "utf8");
      total += extractInputSchemaBlocks(file, source).length;
    }
    // If this drops to zero the regex broke or the directory moved.
    expect(total).toBeGreaterThan(50);
  });
});
