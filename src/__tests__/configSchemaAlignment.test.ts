/**
 * Regression: config.schema.json must list every top-level field on the
 * `PatchworkConfig` TypeScript interface in src/patchworkConfig.ts.
 *
 * Drift previously went undetected because there was no generator and
 * loadConfig() does no AJV validation, so users could write fields the
 * type accepted but the schema rejected (and vice versa). This test
 * fails fast when someone adds a field to the type without updating
 * the schema.
 *
 * If this test fails:
 *   - Added a field to PatchworkConfig?  Update config.schema.json.
 *   - Removed a field from PatchworkConfig?  Remove it from the schema.
 *
 * Top-level only — nested object fields are checked structurally
 * (existence of the parent property), not field-by-field. Keeping the
 * gate top-level keeps the regex parse simple.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function extractInterfaceFields(source: string, name: string): Set<string> {
  // Find `export interface <name> {` and grab balanced-brace block.
  const headerRe = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`);
  const m = headerRe.exec(source);
  if (!m) throw new Error(`interface ${name} not found in source`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const block = source.slice(start, i - 1);

  // Strip nested object/array literal blocks so their inner field names
  // don't leak to the top level.
  let stripped = "";
  let nestDepth = 0;
  for (const ch of block) {
    if (ch === "{") nestDepth++;
    else if (ch === "}") nestDepth--;
    else if (nestDepth === 0) stripped += ch;
  }

  // Match `<name>?:` or `<name>:` at line starts (allowing comments above).
  const fields = new Set<string>();
  const fieldRe = /(?:^|;|\n)\s*(?:\/\*\*[\s\S]*?\*\/\s*)?(\w+)\??\s*:/g;
  let fm: RegExpExecArray | null = fieldRe.exec(stripped);
  while (fm !== null) {
    fields.add(fm[1] as string);
    fm = fieldRe.exec(stripped);
  }
  return fields;
}

describe("config.schema.json ↔ PatchworkConfig alignment", () => {
  it("schema lists every top-level field on the type", () => {
    const repoRoot = join(__dirname, "..", "..");
    const tsSource = readFileSync(
      join(repoRoot, "src", "patchworkConfig.ts"),
      "utf-8",
    );
    const schema = JSON.parse(
      readFileSync(join(repoRoot, "config.schema.json"), "utf-8"),
    ) as { properties: Record<string, unknown> };

    const typeFields = extractInterfaceFields(tsSource, "PatchworkConfig");
    const schemaFields = new Set(Object.keys(schema.properties));

    const missingFromSchema = [...typeFields].filter(
      (f) => !schemaFields.has(f),
    );
    const orphanInSchema = [...schemaFields].filter((f) => !typeFields.has(f));

    expect(
      missingFromSchema,
      "fields in PatchworkConfig but not in schema",
    ).toEqual([]);
    expect(
      orphanInSchema,
      "fields in schema but no longer on PatchworkConfig",
    ).toEqual([]);
  });
});
