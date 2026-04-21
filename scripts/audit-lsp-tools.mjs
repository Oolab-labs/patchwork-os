/**
 * Tool registry audit.
 *
 * Checks six things:
 *   1. Every tool in SLIM_TOOL_NAMES is registered (has a schema name matching
 *      a `name: "..."` entry in a tool source file).
 *   2. Every LSP tool in availableTools.lsp (getToolCapabilities.ts) is also
 *      in SLIM_TOOL_NAMES, and vice versa for known LSP tools.
 *   3. Every tool with outputSchema uses successStructured/successStructuredLarge
 *      (not plain success/successLarge which omit structuredContent).
 *   4. Every tool using successStructured declares outputSchema.
 *   5. Every tool source file that exports a create*Tool function is imported
 *      in index.ts (not accidentally orphaned).
 *   6. Every tool description field is ≤ 200 chars (tools/list is sent on every
 *      request — short descriptions reduce token usage and improve cache hit rates).
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
 * Returns [{name, hasOutputSchema}, ...].
 */
function extractToolNamesFromFile(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const schemaIdx = src.indexOf("schema: {", i);
    if (schemaIdx === -1) break;
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
          if (m)
            out.push({
              name: m[1],
              hasOutputSchema: /\boutputSchema\s*:/.test(block),
            });
          break;
        }
        depth--;
      }
    }
    i = schemaIdx + 9;
  }
  return out;
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
const toolSchemaEntries = []; // {name, file, hasOutputSchema}

for (const f of allToolFiles) {
  const src = readFileSync(path.join(toolsDir, f), "utf8");
  const entries = extractToolNamesFromFile(src);
  if (entries.length) {
    fileToNames.set(
      f,
      entries.map((e) => e.name),
    );
    for (const e of entries) {
      registeredNames.add(e.name);
      toolSchemaEntries.push({ ...e, file: f });
    }
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

// ── check 6: tool description length ─────────────────────────────────────────
//
// Every tool's description field must be ≤ 200 chars (collapsed). The tools/list
// response is sent on every request — keeping descriptions short reduces token
// usage and improves prompt cache hit rates.

const MAX_DESCRIPTION_CHARS = 200;
const descriptionViolations = [];

for (const [f] of fileToNames) {
  if (f === "index.ts" || f === "utils.ts") continue;
  const src = readFileSync(path.join(toolsDir, f), "utf8");
  // Match tool-level description fields (not property-level ones).
  // A tool description sits directly inside the schema object at ~6 spaces indent.
  const re =
    /^\s{6}description:\s*([\s\S]{1,800}?)(?=,\s*\n\s+(?:annotations|inputSchema|extensionRequired|name:|outputSchema)|,\s*\n\s+[a-z])/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1].trim();
    const cleaned = raw
      .replace(/['"]\s*\+\s*['"]/g, "")
      .replace(/^['"`]/, "")
      .replace(/['"`]$/, "")
      .replace(/\n\s*/g, " ")
      .trim();
    if (cleaned.length > MAX_DESCRIPTION_CHARS) {
      descriptionViolations.push(
        `${f}: ${cleaned.length} chars — "${cleaned.slice(0, 60)}…"`,
      );
    }
  }
}

// ── check 7: every tool declares outputSchema (per schema block, incl. subdirs)
//
// Ratcheting gate. Allowlist lives in audit-output-schema-allowlist.json and
// only shrinks. New tools without outputSchema will fail CI.

const allowlistPath = path.join(
  root,
  "scripts",
  "audit-output-schema-allowlist.json",
);
const outputSchemaAllowlist = new Set(
  JSON.parse(readFileSync(allowlistPath, "utf8")).allowlist.map((e) => e.name),
);

function walkToolFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__")
        walkToolFiles(path.join(dir, entry.name), acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const missingOutputSchema = [];
const staleAllowlist = [];
const seenAllowed = new Set();

for (const absFile of walkToolFiles(toolsDir)) {
  const src = readFileSync(absFile, "utf8");
  const entries = extractToolNamesFromFile(src);
  const rel = path.relative(toolsDir, absFile);
  for (const e of entries) {
    if (e.hasOutputSchema) continue;
    if (outputSchemaAllowlist.has(e.name)) {
      seenAllowed.add(e.name);
      continue;
    }
    missingOutputSchema.push(`${e.name} (${rel})`);
  }
}
for (const name of outputSchemaAllowlist) {
  if (!seenAllowed.has(name)) staleAllowlist.push(name);
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

if (descriptionViolations.length === 0) {
  ok(`All tool descriptions are ≤ ${MAX_DESCRIPTION_CHARS} chars`);
} else {
  fail(
    `Tool descriptions exceeding ${MAX_DESCRIPTION_CHARS} chars`,
    descriptionViolations,
  );
}

if (orphaned.length === 0) {
  ok("All tool source files are imported in index.ts");
} else {
  fail("Tool source files not imported in index.ts (orphaned)", orphaned);
}

if (missingOutputSchema.length === 0) {
  ok("All tools declare outputSchema (or are in allowlist)");
} else {
  fail(
    "Tools missing outputSchema (add outputSchema or justify in audit-output-schema-allowlist.json)",
    missingOutputSchema,
  );
}

if (staleAllowlist.length === 0) {
  ok("outputSchema allowlist is clean (no stale entries)");
} else {
  fail(
    "outputSchema allowlist entries with no matching tool (remove from allowlist)",
    staleAllowlist,
  );
}

console.log(
  `\n${issues === 0 ? "All checks passed." : `${issues} issue(s) found — fix before merging.`}`,
);

// Count outputSchema across all subdirs (not just flat toolsDir)
function countOutputSchemaAllDirs(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__")
        count += countOutputSchemaAllDirs(path.join(dir, entry.name));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      const src = readFileSync(path.join(dir, entry.name), "utf8");
      if (/\boutputSchema\s*:/.test(src)) count++;
    }
  }
  return count;
}
const outputSchemaCount = countOutputSchemaAllDirs(toolsDir);

console.log(
  `\nStats: ${slimNames.size} slim tools · ${lspInCaps.size} LSP tools advertised · ${registeredNames.size} total registered · ${lspToolNames.size} LSP implementations · ${outputSchemaCount} outputSchema tools`,
);

process.exit(issues > 0 ? 1 : 0);
