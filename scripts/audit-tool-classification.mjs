/**
 * Action-class coverage ratchet (#1311).
 *
 * `classifyActionClass` (`src/workers/actionClass.ts`) maps a tool name to a
 * governance domain through `DOMAIN_BY_TOOL`. Anything absent falls through to
 * `other` / `irreversible` — a conservative default, and the right one.
 *
 * The bug is that the default became the common case. The map was written
 * against MCP-style camelCase names (`createLinearIssue`); the connector waves
 * then registered ~200 tools under dotted ids (`linear.createIssue`) and nobody
 * extended it. At the time this gate was written, 186 of 211 TRACKED registered recipe
 * tools were unclassified.
 *
 * ## Why that is worth failing CI over, given the default is safe
 *
 * It fails CLOSED, so this is not a security hole — it is over-restriction. But
 * over-restriction here is not harmless:
 *
 *   - Read-only tools land in `irreversible` and get GATED. `linear.listIssues`
 *     is a list operation sitting behind human approval. Reversible actions are
 *     supposed to bypass the gate unconditionally.
 *   - Trust is per (worker × action-class). Collapsing 193 tools into one
 *     `other` bucket means evidence from unrelated actions piles into a single
 *     cell that requires L4 and, being irreversible, cannot be unlocked by a
 *     standing permission either. There may be no path upward at all.
 *   - The same real-world act is governed inconsistently depending on which
 *     connector performs it — a Todoist task is compensable, a Linear issue is
 *     irreversible, and both can be deleted.
 *
 * ## A ratchet, not an allowlist
 *
 * Every entry is a KNOWN GAP, not an approved exception, and the list may only
 * shrink. A newly registered tool with no domain fails, so the next connector
 * wave cannot quietly make 193 into 250. A classified-but-still-listed tool
 * also fails — a ratchet that tolerates stale entries stops measuring anything.
 *
 * ## Static on purpose
 *
 * Parses the TypeScript source rather than importing the compiled module, so it
 * cannot be defeated by a stale or missing `dist/`. It reads slightly MORE than
 * the runtime registry (it sees alias registrations such as
 * `registerTool({ ...listIssues, id: "linear.listIssues" })`), which is the
 * right direction for a gate to err.
 *
 * It enumerates via `git ls-files`, NOT the directory. Reading the directory
 * picks up untracked local work — this tree carries several such tool files —
 * which seeds the ratchet with ids that do not exist in CI, where they read as
 * stale entries and fail the build. That is how this gate first went red.
 *
 * Usage: node scripts/audit-tool-classification.mjs
 * Exit:  0 clean · 1 drift · 2 script/config error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = "scripts/audit-tool-classification-allowlist.json";
const CLASSIFIER = "src/workers/actionClass.ts";
const TOOLS_DIR = "src/recipes/tools";

/** Tool names that already have a governance domain. */
function mappedNames() {
  const src = readFileSync(path.join(root, CLASSIFIER), "utf8");
  const parts = src.split("const DOMAIN_BY_TOOL");
  if (parts.length < 2) {
    console.error(
      `[tool-class] could not find DOMAIN_BY_TOOL in ${CLASSIFIER}`,
    );
    process.exit(2);
  }
  const block = parts[1].split("};")[0];
  return new Set([
    ...[...block.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]),
    ...[...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(
      (m) => m[1],
    ),
  ]);
}

/** Every `id: "namespace.tool"` a recipe tool registers. */
function registeredIds() {
  const ids = new Set();
  let files;
  try {
    // TRACKED files only. Reading the directory instead would include untracked
    // local work (this tree carries several such tool files), seeding the
    // ratchet with ids that do not exist in CI — where they then read as stale
    // entries and fail the build. That is exactly how this gate first went red.
    files = execFileSync("git", ["ls-files", `${TOOLS_DIR}/*.ts`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("__tests__"));
  } catch (err) {
    console.error(`[tool-class] cannot list ${TOOLS_DIR}: ${err.message}`);
    process.exit(2);
  }
  for (const f of files) {
    const text = readFileSync(path.join(root, f), "utf8");
    for (const m of text.matchAll(
      /\bid:\s*"([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)"/g,
    )) {
      ids.add(m[1]);
    }
  }
  return ids;
}

let allow;
try {
  const parsed = JSON.parse(readFileSync(path.join(root, ALLOWLIST), "utf8"));
  if (!Array.isArray(parsed.allow)) throw new Error("`allow` must be an array");
  allow = new Set(parsed.allow);
} catch (err) {
  console.error(`[tool-class] ${ALLOWLIST} unreadable: ${err.message}`);
  process.exit(2);
}

const mapped = mappedNames();
const registered = registeredIds();
const unclassified = [...registered].filter((id) => !mapped.has(id)).sort();

const added = unclassified.filter((id) => !allow.has(id));
const fixed = [...allow].filter((id) => !unclassified.includes(id)).sort();

console.log(
  `[tool-class] ${registered.size} registered · ${unclassified.length} unclassified · ${allow.size} on the ratchet`,
);

if (added.length > 0) {
  console.error(`\n✗ ${added.length} newly unclassified tool(s):\n`);
  for (const id of added) console.error(`  • ${id}`);
  console.error(
    `\nGive each a domain in ${CLASSIFIER} (\`DOMAIN_BY_TOOL\`). Without one it is\n` +
      "treated as irreversible, which gates it behind human approval even when it\n" +
      `is a read. Do NOT add it to ${ALLOWLIST} — that list only shrinks (#1311).\n`,
  );
}

if (fixed.length > 0) {
  console.error(
    `\n✗ ${fixed.length} stale ratchet entr(y/ies) — now mapped:\n`,
  );
  for (const id of fixed) console.error(`  • ${id}`);
  console.error(`\nDelete these lines from ${ALLOWLIST}.\n`);
}

if (added.length || fixed.length) process.exit(1);
console.log("[tool-class] OK — the ratchet holds.");
process.exit(0);
