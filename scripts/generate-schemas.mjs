#!/usr/bin/env node
/**
 * Generate static JSON Schema files from the recipe schema generator.
 * Output: schemas/recipe.v1.json, schemas/dry-run-plan.v1.json
 *         dashboard/public/schema/ (same files, served at patchworkos.com/schema/)
 *
 * Run after `npm run build` when recipe schema changes.
 * Commit both outputs — schemas/ is the source of truth, dashboard/public/schema/ is the CDN copy.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { generateSchemaSet } = await import(
  "../dist/recipes/schemaGenerator.js"
);

const schemas = generateSchemaSet();

mkdirSync(join(root, "schemas", "tools"), { recursive: true });

writeFileSync(
  join(root, "schemas", "recipe.v1.json"),
  JSON.stringify(schemas.recipe, null, 2),
);
writeFileSync(
  join(root, "schemas", "dry-run-plan.v1.json"),
  JSON.stringify(schemas.dryRunPlan, null, 2),
);

let nsCount = 0;
for (const [ns, schema] of Object.entries(schemas.namespaces)) {
  writeFileSync(
    join(root, "schemas", "tools", `${ns}.json`),
    JSON.stringify(schema, null, 2),
  );
  nsCount++;
}

// Sync to dashboard/public/schema/ so Next.js serves them at /schema/recipe.v1.json
const publicSchema = join(root, "dashboard", "public", "schema");
mkdirSync(publicSchema, { recursive: true });
writeFileSync(
  join(publicSchema, "recipe.v1.json"),
  JSON.stringify(schemas.recipe, null, 2),
);
writeFileSync(
  join(publicSchema, "dry-run-plan.v1.json"),
  JSON.stringify(schemas.dryRunPlan, null, 2),
);

console.log(
  `✓ schemas/ + dashboard/public/schema/ updated${nsCount > 0 ? ` (${nsCount} namespaces)` : ""}`,
);
