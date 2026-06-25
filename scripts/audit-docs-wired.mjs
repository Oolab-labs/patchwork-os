/**
 * "Documented ⇒ wired" parity audit (issue #850, acceptance criterion #3).
 *
 * The docs are a contract: anything the docs present as usable must actually
 * exist in the code's source-of-truth surfaces. This script asserts three
 * cross-layer invariants and exits 1 on any mismatch.
 *
 *   1. PROMPTS — the count of top-level entries in `PROMPTS: McpPrompt[]`
 *      (src/prompts.ts) must equal the "<N> MCP prompts" number documented in
 *      documents/platform-docs.md (banner line) AND in CLAUDE.md. The doc number
 *      is parsed, never hardcoded.
 *
 *   2. CLI subcommands — every subcommand DOCUMENTED in CLAUDE.md's
 *      "### CLI Subcommands" section must be present in the code's wired set
 *      (KNOWN_SUBCOMMANDS array ∪ every `process.argv[2] === "x"` dispatch in
 *      src/index.ts). "Documented ⇒ wired." Registered-but-undocumented
 *      subcommands are REPORTED (informational), not failed — over-documenting
 *      is the dangerous direction, not under-documenting.
 *
 *   3. Automation hooks — every hook key the docs present as usable must be
 *      accepted by the policy loader. The wired surface is:
 *        - the HookType union (src/fp/automationProgram.ts) — the legacy/internal
 *          slots the parser (src/fp/policyParser.ts) handles, AND
 *        - the unified aliases that loadPolicy (src/automation.ts) expands into
 *          those slots (onCompaction, onDiagnosticsStateChange, onDebugSession).
 *      The "<N> automation hooks" banner number in platform-docs.md must equal
 *      the count of distinct accepted hook keys. (This script does NOT mutate
 *      docs; if the number is wrong it fails and prints the value to set.)
 *
 * Usage:
 *   node scripts/audit-docs-wired.mjs
 *
 * Exit code 0 = all checks pass. Exit code 1 = issues found.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

const problems = [];
const notes = [];

// ── 1. PROMPTS ─────────────────────────────────────────────────────────────

function auditPrompts() {
  const src = read("src/prompts.ts");
  // Slice the PROMPTS array literal: from `export const PROMPTS` to the matching
  // top-level `];`. Top-level entries are `  {` at two-space indent.
  const start = src.indexOf("export const PROMPTS");
  if (start === -1) {
    problems.push(
      "prompts: could not find `export const PROMPTS` in src/prompts.ts",
    );
    return;
  }
  // Each prompt object opens with a two-space-indented `{` and carries a
  // four-space-indented `name: "..."`. Count names — robust against nested
  // braces in descriptions.
  const arrEnd = src.indexOf("\n];", start);
  const slice = src.slice(start, arrEnd === -1 ? undefined : arrEnd);
  const names = [...slice.matchAll(/^ {4}name: "([^"]+)",/gm)].map((m) => m[1]);
  const codeCount = new Set(names).size;
  if (names.length !== codeCount) {
    problems.push(
      `prompts: duplicate prompt names in src/prompts.ts (${names.length} entries, ${codeCount} unique)`,
    );
  }

  for (const [docRel, label] of [
    ["documents/platform-docs.md", "platform-docs.md"],
    ["CLAUDE.md", "CLAUDE.md"],
  ]) {
    const doc = read(docRel);
    const m = doc.match(/(\d+)\s+MCP prompts/);
    if (!m) {
      problems.push(`prompts: could not find "<N> MCP prompts" in ${label}`);
      continue;
    }
    const docCount = Number(m[1]);
    if (docCount !== codeCount) {
      problems.push(
        `prompts: ${label} says "${docCount} MCP prompts" but src/prompts.ts has ${codeCount}. Set the doc number to ${codeCount}.`,
      );
    }
  }
  notes.push(`prompts: ${codeCount} entries in PROMPTS[]`);
}

// ── 2. CLI subcommands ───────────────────────────────────────────────────────

function auditSubcommands() {
  const idx = read("src/index.ts");

  // Wired set A: the KNOWN_SUBCOMMANDS array literal.
  const knownMatch = idx.match(
    /const KNOWN_SUBCOMMANDS\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  const wired = new Set();
  if (knownMatch) {
    for (const m of knownMatch[1].matchAll(/"([a-z][a-z-]*)"/g))
      wired.add(m[1]);
  } else {
    problems.push(
      "subcommands: could not find KNOWN_SUBCOMMANDS array in src/index.ts",
    );
  }
  // Wired set B: every `process.argv[2] === "x"` dispatch. Some subcommands
  // (e.g. `tools`) dispatch directly without being in KNOWN_SUBCOMMANDS.
  for (const m of idx.matchAll(
    /process\.argv\[2\]\s*===\s*"([a-z][a-z-]*)"/g,
  )) {
    wired.add(m[1]);
  }
  // Drop pseudo-commands that are flags/help, never documented as subcommands.
  for (const pseudo of ["help", "patchwork-init"]) wired.delete(pseudo);

  // Documented set: top-level `- \`<cmd>\`` bullets inside the
  // "### CLI Subcommands" section of CLAUDE.md, up to the next "## " heading.
  const claude = read("CLAUDE.md");
  const secStart = claude.indexOf("### CLI Subcommands");
  if (secStart === -1) {
    problems.push(
      "subcommands: could not find '### CLI Subcommands' in CLAUDE.md",
    );
    return;
  }
  const secEnd = claude.indexOf("\n## ", secStart);
  const section = claude.slice(secStart, secEnd === -1 ? undefined : secEnd);
  // A documented subcommand is the first token of a top-level bullet:
  // `- \`init ...\`` → "init". Ignore flags (`--watch`) and release channels
  // (latest/beta/canary) which are not subcommands.
  const documented = new Set();
  for (const line of section.split("\n")) {
    const m = line.match(/^- `([a-z][a-z-]*)\b/);
    if (m) documented.add(m[1]);
  }
  const NON_SUBCOMMAND_TOKENS = new Set(["latest", "beta", "canary"]);
  for (const t of NON_SUBCOMMAND_TOKENS) documented.delete(t);

  // Documented ⇒ wired (the failure direction).
  const missing = [...documented].filter((c) => !wired.has(c)).sort();
  if (missing.length > 0) {
    problems.push(
      `subcommands: documented in CLAUDE.md but NOT wired in src/index.ts: ${missing.join(", ")}`,
    );
  }
  // Wired but undocumented — informational only.
  const undocumented = [...wired].filter((c) => !documented.has(c)).sort();
  if (undocumented.length > 0) {
    notes.push(
      `subcommands: wired but not documented (informational): ${undocumented.join(", ")}`,
    );
  }
  notes.push(`subcommands: ${documented.size} documented, ${wired.size} wired`);
}

// ── 3. Automation hooks ──────────────────────────────────────────────────────

function auditHooks() {
  // Wired surface: HookType union (legacy/internal slots the parser handles).
  const prog = read("src/fp/automationProgram.ts");
  const unionMatch = prog.match(/export type HookType\s*=([\s\S]*?);/);
  if (!unionMatch) {
    problems.push(
      "hooks: could not find HookType union in src/fp/automationProgram.ts",
    );
    return;
  }
  const internal = new Set(
    [...unionMatch[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]),
  );

  // Unified aliases that loadPolicy expands into internal slots. Derived from
  // the expandDiscriminatedHook(...,"<unifiedKey>",...) call sites in
  // src/automation.ts — these are the parseable user-facing hook keys that do
  // NOT appear in the HookType union.
  const auto = read("src/automation.ts");
  const unified = new Set(
    [
      ...auto.matchAll(/expandDiscriminatedHook\(\s*policy,\s*"([a-zA-Z]+)"/g),
    ].map((m) => m[1]),
  );

  // Accepted hook keys = internal slots ∪ unified aliases.
  const accepted = new Set([...internal, ...unified]);
  const acceptedCount = accepted.size;

  // The platform-docs banner "<N> automation hooks" must equal acceptedCount.
  const docs = read("documents/platform-docs.md");
  const banner = docs.match(/(\d+)\s+automation hooks/);
  if (!banner) {
    problems.push(
      'hooks: could not find "<N> automation hooks" banner in platform-docs.md',
    );
  } else if (Number(banner[1]) !== acceptedCount) {
    problems.push(
      `hooks: platform-docs.md banner says "${banner[1]} automation hooks" but the policy loader accepts ${acceptedCount} distinct hook keys. Set the banner to ${acceptedCount}.`,
    );
  }

  // The "<N> hook keys" sentence in the Automation Hooks section must also match.
  const sectionN = docs.match(/JSON file with any of these (\d+) hook keys/);
  if (sectionN && Number(sectionN[1]) !== acceptedCount) {
    problems.push(
      `hooks: platform-docs.md "any of these ${sectionN[1]} hook keys" but loader accepts ${acceptedCount}. Set it to ${acceptedCount}.`,
    );
  }

  // Contract: every hook the docs/rules present as usable must be parseable.
  // The unified names are presented as the current form in CLAUDE.md +
  // .claude/rules/automation.md — assert the loader accepts them.
  for (const uni of [
    "onDiagnosticsStateChange",
    "onCompaction",
    "onDebugSession",
  ]) {
    if (!accepted.has(uni)) {
      problems.push(
        `hooks: docs present unified hook "${uni}" as usable but loadPolicy does not expand it (real drift — investigate src/automation.ts).`,
      );
    }
  }
  notes.push(
    `hooks: ${acceptedCount} accepted keys (${internal.size} internal + ${unified.size} unified aliases)`,
  );
}

// ── run ──────────────────────────────────────────────────────────────────────

auditPrompts();
auditSubcommands();
auditHooks();

for (const n of notes) console.log(`  ℹ ${n}`);
if (problems.length > 0) {
  console.error("\n✖ docs⇒wired audit failed:\n");
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log("\n✓ docs⇒wired audit passed");
