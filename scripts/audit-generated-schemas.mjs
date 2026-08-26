#!/usr/bin/env node
/**
 * Are the committed JSON Schemas what the generator currently produces?
 *
 * `schemas/` and `dashboard/public/schema/` are GENERATED from
 * `src/recipes/schemaGenerator.ts` by `npm run schema:generate`, and committed.
 * Nothing checked that the two agreed, so an edit to the generator without a
 * regeneration shipped silently — and it had: measured 2026-08-26, the
 * committed `recipe.v1.json` was 259 lines behind its generator and
 * `dry-run-plan.v1.json` 19, the difference being enums and `required` arrays
 * the generator had since added.
 *
 * That direction is the dangerous one. The published schema is what an editor
 * loads through the SchemaStore pragma, so a LOOSER committed copy means an
 * author is told their recipe is fine while the runtime validator would
 * constrain it. The recipe lints clean in the editor and fails later, which is
 * the failure family this repo keeps paying for.
 *
 * Compares PARSED CONTENT, not bytes, and that is load-bearing rather than
 * lenient. `schema:generate` writes `JSON.stringify(x, null, 2)`, which is NOT
 * what `biome check` wants for a `.json` file — so a regeneration fails Lint
 * until the file is reformatted, and a reformatted file no longer matches the
 * generator byte for byte. A byte gate would therefore be unsatisfiable: it
 * would demand exactly the state the linter rejects. That incompatibility is
 * also the ROOT CAUSE of the drift this gate exists to catch — regenerating
 * broke the build, so it stopped being done. Comparing parsed values lets the
 * formatter own whitespace and this gate own meaning.
 *
 * Compares in memory and NEVER writes: a gate that fixes the thing it is
 * checking reports success on a repository that is still wrong, and the fix
 * would land unreviewed. It prints WHICH file and what differs, never the
 * schema body — a multi-thousand-line JSON dump in CI output is how a real
 * signal gets scrolled past.
 *
 * Requires `dist/` — run after `npm run build`. Missing `dist/` is reported as
 * a SKIP with a non-zero exit rather than a pass: "I could not check" must
 * never render as "it is fine".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = join(root, "dist", "recipes", "schemaGenerator.js");

if (!existsSync(generated)) {
  process.stderr.write(
    "[generated-schemas] dist/ is missing — run `npm run build` first.\n" +
      "[generated-schemas] NOT VERIFIED (exiting non-zero: an unchecked schema is not a passing one).\n",
  );
  process.exit(2);
}

const { generateSchemaSet } = await import(generated);
const schemas = generateSchemaSet();

/** Every committed artefact and the generator output it must equal. */
const targets = [
  [join(root, "schemas", "recipe.v1.json"), schemas.recipe],
  [join(root, "schemas", "dry-run-plan.v1.json"), schemas.dryRunPlan],
  [
    join(root, "dashboard", "public", "schema", "recipe.v1.json"),
    schemas.recipe,
  ],
  [
    join(root, "dashboard", "public", "schema", "dry-run-plan.v1.json"),
    schemas.dryRunPlan,
  ],
];
for (const [ns, schema] of Object.entries(schemas.namespaces ?? {})) {
  targets.push([join(root, "schemas", "tools", `${ns}.json`), schema]);
}

/** Order-insensitive canonical JSON, so key order is not a schema difference. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const stale = [];
for (const [file, expected] of targets) {
  if (!existsSync(file)) {
    stale.push({ file, reason: "missing" });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    stale.push({
      file,
      reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    });
    continue;
  }
  // Canonical form on BOTH sides so key order and whitespace are out of scope
  // and only meaning is compared.
  if (canonical(parsed) !== canonical(expected)) {
    stale.push({ file, reason: "content differs from the generator output" });
  }
}

if (stale.length > 0) {
  process.stderr.write(
    `[generated-schemas] ${stale.length} committed schema file(s) do not match the generator:\n`,
  );
  for (const s of stale) {
    process.stderr.write(`  ✗ ${relative(root, s.file)} — ${s.reason}\n`);
  }
  process.stderr.write(
    "[generated-schemas] Fix: npm run build && npm run schema:generate && npx biome check --write schemas/ dashboard/public/schema/\n" +
      "[generated-schemas] The biome step is NOT optional — the generator writes JSON the linter rejects, and skipping it turns Lint red.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `[generated-schemas] OK — ${targets.length} generated schema file(s) match their generator.\n`,
);
