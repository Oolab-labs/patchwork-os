#!/usr/bin/env node
/**
 * Generate static JSON Schema files from the recipe schema generator.
 * Output: schemas/recipe.v1.json, schemas/dry-run-plan.v1.json
 *
 * Run after `npm run build` when recipe schema changes.
 * Commit the output — schemas/ is served as static files and referenced by SchemaStore.
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

console.log(
  `✓ schemas/recipe.v1.json, schemas/dry-run-plan.v1.json${nsCount > 0 ? `, schemas/tools/ (${nsCount} namespaces)` : ""}`,
);
