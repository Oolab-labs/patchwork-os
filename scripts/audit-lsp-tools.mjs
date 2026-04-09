/**
 * Tool registry audit.
 *
 * Checks five things:
 *   1. Every tool in SLIM_TOOL_NAMES is registered (has a schema name matching
 *      a `name: "..."` entry in a tool source file).
 *   2. Every LSP tool in availableTools.lsp (getToolCapabilities.ts) is also
 *      in SLIM_TOOL_NAMES, and vice versa for known LSP tools.
 *   3. Every tool with outputSchema uses successStructured/successStructuredLarge
 *      (not plain success/successLarge which omit structuredContent).
 *   4. Every tool using successStructured declares outputSchema.
 *   5. Every tool source file that exports a create*Tool function is imported
 *      in index.ts (not accidentally orphaned).
 *
 * Usage:
 *   node scripts/audit-lsp-tools.mjs
 *
 * Exit code 0 = all checks pass. Exit code 1 = issues found.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const toolsDir = path.join(root, "src", "tools");

// ── helpers ───────────────────────────────────────────────────────────────────

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function extractStringSet(src, varName) {
  const re = new RegExp(
    `${varName}\\s*=\\s*new Set[^(]*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
  );
  const m = src.match(re);
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

function extractLspArray(src) {
  // Extract the connected-branch array: lsp: extensionClient.isConnected() ? [ ... ] : []
  const re =
    /lsp:\s*extensionClient\.isConnected\(\)\s*\?\s*\[([\s\S]*?)\]\s*:/;
  const m = src.match(re);
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

/**
 * Scan a tool source file and return all schema tool names.
 * Finds every `schema: { ... name: "toolName" ... }` block.
 */
function extractToolNamesFromFile(src) {
  const names = [];
  // Find each `schema: {` and scan forward for the closing `}` to get the name
  let i = 0;
  while (i < src.length) {
    const schemaIdx = src.indexOf("schema: {", i);
    if (schemaIdx === -1) break;
    // Walk forward to find the matching `}` (depth-1 close)
    let depth = 0;
    let blockStart = -1;
    for (let j = schemaIdx + 8; j < src.length; j++) {
      if (src[j] === "{") {
        depth++;
        if (depth === 1) blockStart = j;
      } else if (src[j] === "}") {
        if (depth === 1) {
          const block = src.slice(blockStart, j + 1);
          const m = block.match(/\bname:\s*"([a-zA-Z][a-zA-Z0-9_]+)"/);
          if (m) names.push(m[1]);
          break;
        }
        depth--;
      }
    }
    i = schemaIdx + 9;
  }
  return names;
}

// ── load sources ──────────────────────────────────────────────────────────────

const indexSrc = read("src/tools/index.ts");
const capsSrc = read("src/tools/getToolCapabilities.ts");

const slimNames = extractStringSet(indexSrc, "SLIM_TOOL_NAMES");
const lspInCaps = extractLspArray(capsSrc);

if (!slimNames || !lspInCaps) {
  console.error("Failed to parse source files — regex may need updating.");
  process.exit(1);
}

// Collect all schema tool names from tool source files
const allToolFiles = readdirSync(toolsDir).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
);
const registeredNames = new Set();
const fileToNames = new Map(); // file → [toolName, ...]

for (const f of allToolFiles) {
  const src = readFileSync(path.join(toolsDir, f), "utf8");
  const names = extractToolNamesFromFile(src);
  if (names.length) {
    fileToNames.set(f, names);
    for (const n of names) registeredNames.add(n);
  }
}

// ── check 1: SLIM_TOOL_NAMES ↔ registered names ───────────────────────────────

const inSlimNotRegistered = [...slimNames].filter(
  (t) => !registeredNames.has(t),
);

// ── check 2: availableTools.lsp ↔ SLIM_TOOL_NAMES ────────────────────────────

const inLspNotSlim = [...lspInCaps].filter((t) => !slimNames.has(t));

// For the reverse check, we need to know which SLIM_TOOL_NAMES are LSP tools.
// A tool is "LSP" if it lives in a file that has extensionRequired: true or
// calls an LSP method on extensionClient. We use availableTools.lsp as the
// ground truth for what's LSP — any slim tool NOT in lspInCaps and NOT in the
// non-LSP categories is suspicious.
//
// We check: every slim tool that IS in registeredNames and IS lsp-flavored
// (its source file uses extensionClient LSP methods) should appear in lspInCaps.
const lspMethodPattern =
  /extensionClient\.(goToDefinition|findReferences|getHover|getCallHierarchy|renameSymbol|getCodeActions|applyCodeAction|getDocumentSymbols|searchWorkspaceSymbols|getTypeHierarchy|getInlayHints|getHoverAtCursor|refactorPreview|prepareRename|signatureHelp|getSemanticTokens|getCodeLens|getChangeImpact|getImportedSignatures|getDocumentLinks|batchGetHover|batchGoToDefinition|refactorExtractFunction|explainSymbol|foldingRanges|selectionRanges|refactorAnalyze|getImportTree)\b/;

const lspToolNames = new Set();
for (const [f, names] of fileToNames) {
  const src = readFileSync(path.join(toolsDir, f), "utf8");
  if (lspMethodPattern.test(src)) {
    for (const n of names) lspToolNames.add(n);
  }
}

const inSlimLspNotCaps = [...lspToolNames].filter(
  (t) => slimNames.has(t) && !lspInCaps.has(t),
);

// ── check 3: outputSchema ↔ successStructured consistency ────────────────────
//
// Every tool file that declares `outputSchema:` must return structuredContent
// by using successStructured() or successStructuredLarge() — not the plain
// success()/successLarge() variants (which omit the structuredContent field).

const outputSchemaWithoutStructured = [];
const structuredWithoutOutputSchema = [];

for (const [f] of fileToNames) {
  if (f === "index.ts" || f === "utils.ts") continue;
  const src = readFileSync(path.join(toolsDir, f), "utf8");
  const hasOutputSchema = /\boutputSchema\s*:/.test(src);
  const hasSuccessStructured = /\bsuccessStructured(?:Large)?\s*\(/.test(src);
  const hasPlainSuccess = /\breturn success(?:Large)?\s*\(/.test(src);

  if (hasOutputSchema && hasPlainSuccess && !hasSuccessStructured) {
    outputSchemaWithoutStructured.push(f);
  }
  if (hasSuccessStructured && !hasOutputSchema) {
    structuredWithoutOutputSchema.push(f);
  }
}

// ── check 5: orphaned tool source files ──────────────────────────────────────

// Any .ts file in src/tools/ that exports create*Tool but is NOT imported in index.ts
const orphaned = [];
for (const [f] of fileToNames) {
  if (f === "index.ts") continue;
  const base = f.replace(/\.ts$/, "");
  // Check if index.ts imports from this file
  if (
    !indexSrc.includes(`"./${base}.js"`) &&
    !indexSrc.includes(`'./${base}.js'`)
  ) {
    orphaned.push(f);
  }
}

// ── report ────────────────────────────────────────────────────────────────────

let issues = 0;

function fail(label, items) {
  if (!items.length) return;
  issues += items.length;
  console.error(`\n✗ ${label} (${items.length}):`);
  for (const item of items.sort()) console.error(`    - ${item}`);
}

function ok(label) {
  console.log(`✓ ${label}`);
}

console.log(`\nTool Registry Audit\n${"─".repeat(40)}`);

if (inSlimNotRegistered.length === 0) {
  ok("All SLIM_TOOL_NAMES entries have a registered schema");
} else {
  fail("In SLIM_TOOL_NAMES but no matching schema found", inSlimNotRegistered);
}

if (inLspNotSlim.length === 0) {
  ok("All availableTools.lsp entries are in SLIM_TOOL_NAMES");
} else {
  fail("In availableTools.lsp but missing from SLIM_TOOL_NAMES", inLspNotSlim);
}

if (inSlimLspNotCaps.length === 0) {
  ok("All LSP tools in SLIM_TOOL_NAMES appear in availableTools.lsp");
} else {
  fail(
    "LSP tools in SLIM_TOOL_NAMES but missing from availableTools.lsp",
    inSlimLspNotCaps,
  );
}

if (outputSchemaWithoutStructured.length === 0) {
  ok(
    "All tools with outputSchema use successStructured/successStructuredLarge",
  );
} else {
  fail(
    "Tools with outputSchema but returning plain success() — missing structuredContent",
    outputSchemaWithoutStructured,
  );
}

if (structuredWithoutOutputSchema.length === 0) {
  ok("All tools using successStructured declare outputSchema");
} else {
  fail(
    "Tools using successStructured but missing outputSchema declaration",
    structuredWithoutOutputSchema,
  );
}

if (orphaned.length === 0) {
  ok("All tool source files are imported in index.ts");
} else {
  fail("Tool source files not imported in index.ts (orphaned)", orphaned);
}

console.log(
  `\n${issues === 0 ? "All checks passed." : `${issues} issue(s) found — fix before merging.`}`,
);

console.log(
  `\nStats: ${slimNames.size} slim tools · ${lspInCaps.size} LSP tools advertised · ${registeredNames.size} total registered · ${lspToolNames.size} LSP implementations · ${[...fileToNames.keys()].filter((f) => /\boutputSchema\s*:/.test(readFileSync(path.join(toolsDir, f), "utf8"))).length} outputSchema tools`,
);

process.exit(issues > 0 ? 1 : 0);
