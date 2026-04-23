#!/usr/bin/env node
/**
 * publish-schemas.mjs
 *
 * Uploads the generated Patchwork recipe schema set to patchwork.sh/schema/
 * so the public $schema URLs resolve after each npm publish.
 *
 * Usage (called automatically by prepublishOnly):
 *   node scripts/publish-schemas.mjs
 *
 * Env vars:
 *   PATCHWORK_SCHEMA_UPLOAD_URL   Base URL to PUT files to (e.g. https://deploy-hook.patchwork.sh/schema)
 *   PATCHWORK_SCHEMA_UPLOAD_TOKEN Bearer token for the upload endpoint
 *   PATCHWORK_SCHEMA_DRY_RUN      Set to "1" to print files without uploading (default in CI when token absent)
 *
 * If PATCHWORK_SCHEMA_UPLOAD_URL is not set the script writes schemas to
 * dist/schemas/ and prints a reminder — safe to run locally or in forks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Dynamic import from compiled dist so we don't need ts-node
const distSchemaGen = path.join(root, "dist", "recipes", "schemaGenerator.js");
if (!fs.existsSync(distSchemaGen)) {
  console.error(
    `[publish-schemas] dist/recipes/schemaGenerator.js not found — run npm run build first`,
  );
  process.exit(1);
}

const { generateSchemaSet, writeSchemas } = await import(distSchemaGen);
const schemas = generateSchemaSet();

const uploadUrl = process.env.PATCHWORK_SCHEMA_UPLOAD_URL;
const uploadToken = process.env.PATCHWORK_SCHEMA_UPLOAD_TOKEN;
const dryRun =
  process.env.PATCHWORK_SCHEMA_DRY_RUN === "1" || (!uploadUrl && !uploadToken);

const outDir = path.join(root, "dist", "schemas");

// Always write to dist/schemas/ as a local artefact
await writeSchemas(outDir, schemas, async (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
});

const files = collectFiles(outDir);
console.log(
  `[publish-schemas] Generated ${files.length} schema files → dist/schemas/`,
);

if (dryRun) {
  console.log(
    `[publish-schemas] DRY RUN — set PATCHWORK_SCHEMA_UPLOAD_URL + PATCHWORK_SCHEMA_UPLOAD_TOKEN to upload`,
  );
  for (const f of files) {
    console.log(`  ${path.relative(outDir, f)}`);
  }
  process.exit(0);
}

// Upload each file via PUT
let uploaded = 0;
let failed = 0;
for (const f of files) {
  const rel = path.relative(outDir, f).replace(/\\/g, "/");
  const url = `${uploadUrl.replace(/\/$/, "")}/${rel}`;
  const body = fs.readFileSync(f, "utf8");

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/schema+json",
        Authorization: `Bearer ${uploadToken}`,
      },
      body,
    });
    if (!res.ok) {
      console.error(
        `[publish-schemas] PUT ${url} → ${res.status} ${res.statusText}`,
      );
      failed++;
    } else {
      uploaded++;
    }
  } catch (err) {
    console.error(`[publish-schemas] PUT ${url} failed: ${err.message}`);
    failed++;
  }
}

console.log(`[publish-schemas] Uploaded ${uploaded}/${files.length} files`);
if (failed > 0) {
  console.error(
    `[publish-schemas] ${failed} upload(s) failed — schemas may be stale on patchwork.sh`,
  );
  process.exit(1);
}

function collectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(full));
    else results.push(full);
  }
  return results;
}
