#!/usr/bin/env node
/**
 * One-shot codemod: replace every `JSON.stringify({error: err.message})` 500
 * response in the bridge HTTP route handlers with `respond500(res, err)`.
 *
 * Patterns it rewrites (whitespace-tolerant):
 *
 *   A. with !res.headersSent guard:
 *        if (!res.headersSent) {
 *          res.writeHead(500, { "Content-Type": "application/json" });
 *          res.end(
 *            JSON.stringify({
 *              error: err instanceof Error ? err.message : String(err),
 *            }),
 *          );
 *        }
 *
 *   B. without guard:
 *        res.writeHead(500, { "Content-Type": "application/json" });
 *        res.end(
 *          JSON.stringify({
 *            error: err instanceof Error ? err.message : String(err),
 *          }),
 *        );
 *
 *   C. one-liner String(err):
 *        res.writeHead(500, { "Content-Type": "application/json" });
 *        res.end(JSON.stringify({ error: String(err) }));
 *
 *   D. one-liner with !res.headersSent:
 *        if (!res.headersSent) {
 *          res.writeHead(500, { "Content-Type": "application/json" });
 *          res.end(JSON.stringify({ error: String(err) }));
 *        }
 *
 * The error-binding identifier is whatever the catch block names it (`err`,
 * `e`, `error`, etc.) — captured from the literal in the body.
 *
 * After rewriting, the script re-verifies that the file still parses by
 * shelling out to tsc — but that's left to the caller (run `npm run
 * typecheck` after).
 */

import fs from "node:fs";
import path from "node:path";

const FILES = [
  "src/connectorRoutes.ts",
  "src/server.ts",
  "src/recipeRoutes.ts",
  "src/inboxRoutes.ts",
  "src/oauthRoutes.ts",
];

const ROOT = path.resolve(process.argv[2] ?? ".");

let totalReplacements = 0;
const importLine = `import { respond500 } from "./httpErrorResponse.js";`;

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  let src = fs.readFileSync(file, "utf-8");
  let count = 0;

  // Pattern A: with headersSent guard, multi-line stringify
  // Capture the indentation so we can preserve it.
  const reA =
    /(^[ \t]*)if \(!res\.headersSent\) \{\s*\n[ \t]*res\.writeHead\(500, \{ "Content-Type": "application\/json" \}\);\s*\n[ \t]*res\.end\(\s*\n[ \t]*JSON\.stringify\(\{\s*\n[ \t]*error: (\w+) instanceof Error \? \2\.message : String\(\2\),?\s*\n[ \t]*\}\),?\s*\n[ \t]*\);\s*\n[ \t]*\}/gm;
  src = src.replace(reA, (_m, indent, errVar) => {
    count++;
    return `${indent}respond500(res, ${errVar});`;
  });

  // Pattern B: no guard, multi-line stringify
  const reB =
    /(^[ \t]*)res\.writeHead\(500, \{ "Content-Type": "application\/json" \}\);\s*\n[ \t]*res\.end\(\s*\n[ \t]*JSON\.stringify\(\{\s*\n[ \t]*error: (\w+) instanceof Error \? \2\.message : String\(\2\),?\s*\n[ \t]*\}\),?\s*\n[ \t]*\);/gm;
  src = src.replace(reB, (_m, indent, errVar) => {
    count++;
    return `${indent}respond500(res, ${errVar});`;
  });

  // Pattern D: one-liner with guard
  const reD =
    /(^[ \t]*)if \(!res\.headersSent\) \{\s*\n[ \t]*res\.writeHead\(500, \{ "Content-Type": "application\/json" \}\);\s*\n[ \t]*res\.end\(JSON\.stringify\(\{ error: String\((\w+)\) \}\)\);\s*\n[ \t]*\}/gm;
  src = src.replace(reD, (_m, indent, errVar) => {
    count++;
    return `${indent}respond500(res, ${errVar});`;
  });

  // Pattern C: one-liner without guard
  const reC =
    /(^[ \t]*)res\.writeHead\(500, \{ "Content-Type": "application\/json" \}\);\s*\n[ \t]*res\.end\(JSON\.stringify\(\{ error: String\((\w+)\) \}\)\);/gm;
  src = src.replace(reC, (_m, indent, errVar) => {
    count++;
    return `${indent}respond500(res, ${errVar});`;
  });

  if (count > 0) {
    // Insert the import if not already present. Walk the file line-by-line
    // until the import block ends — handles single-line AND multi-line
    // (`import { … } from "…"` spanning many lines) imports correctly. The
    // import block ends at the first non-import, non-blank, non-`//` line.
    if (!src.includes('"./httpErrorResponse.js"')) {
      const lines = src.split("\n");
      let depth = 0;
      let lastImportEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (depth === 0 && /^\s*import\b/.test(line)) {
          depth += (line.match(/\{/g) ?? []).length;
          depth -= (line.match(/\}/g) ?? []).length;
          if (depth === 0) lastImportEnd = i;
          continue;
        }
        if (depth > 0) {
          depth += (line.match(/\{/g) ?? []).length;
          depth -= (line.match(/\}/g) ?? []).length;
          if (depth === 0) lastImportEnd = i;
          continue;
        }
        // Allow blank / comment lines inside the import region without ending
        // the block — but stop once we see real code.
        if (/^\s*$/.test(line) || /^\s*\/\//.test(line)) continue;
        break;
      }
      if (lastImportEnd >= 0) {
        lines.splice(lastImportEnd + 1, 0, importLine);
      } else {
        lines.unshift(importLine);
      }
      src = lines.join("\n");
    }
    fs.writeFileSync(file, src);
    console.log(`  ${rel}: ${count} replacements`);
    totalReplacements += count;
  } else {
    console.log(`  ${rel}: 0 replacements`);
  }
}

console.log(
  `\nTotal: ${totalReplacements} replacements across ${FILES.length} files`,
);
