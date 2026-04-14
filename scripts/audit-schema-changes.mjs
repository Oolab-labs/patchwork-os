#!/usr/bin/env node
/**
 * audit-schema-changes.mjs
 *
 * Diffs current tool schemas against the committed baseline snapshot.
 * Run with --update to regenerate the baseline.
 *
 * Exit codes:
 *   0 — no breaking changes (additive changes allowed)
 *   1 — breaking changes detected (removed tools / removed required params / changed required list)
 *
 * Used in CI as the `schema-audit` job (runs after build, before smoke).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SNAPSHOT_PATH = path.join(
  ROOT,
  "documents",
  "tool-schemas-snapshot.json",
);
const CHANGELOG_PATH = path.join(ROOT, "documents", "tool-schema-changelog.md");

const UPDATE = process.argv.includes("--update");
const QUIET = process.argv.includes("--quiet");

// ── Load current schemas from dist (compiled) ─────────────────────────────────

const { McpTransport } = await import(path.join(ROOT, "dist/transport.js"));
const { Logger } = await import(path.join(ROOT, "dist/logger.js"));
const { registerAllTools } = await import(
  path.join(ROOT, "dist/tools/index.js")
);
const { ActivityLog } = await import(path.join(ROOT, "dist/activityLog.js"));

const logger = new Logger(false);
const transport = new McpTransport(logger);
transport.workspace = "/tmp";

const config = {
  workspace: "/tmp",
  workspaceFolders: [],
  fullMode: true, // full mode to capture ALL tools
  commandAllowlist: [],
  toolRateLimit: 60,
  gracePeriodMs: 120_000,
  maxHttpSessions: 5,
  auditLogPath: undefined,
  automation: false,
  claudeDriver: "none",
  vps: false,
  db: false,
  linters: [],
  allowPrivateHttp: false,
  editorCommand: undefined,
  githubDefaultRepo: undefined,
  port: 37100,
};

// Minimal probe set (just enough for tools to register — probes affect availability display, not schema)
const probes = {
  rg: "/bin/rg",
  git: "/usr/bin/git",
  gh: null,
  vitest: null,
  jest: null,
  pytest: null,
  cargo: null,
  goTest: null,
  prettier: null,
  biome: null,
  eslint: null,
  tsc: null,
  rustfmt: null,
  gofmt: null,
  black: null,
  ruff: null,
  pyright: null,
  universalCtags: null,
  typescriptLanguageServer: null,
};

// Mock extension client — schemas are static, no runtime calls needed
const extClient = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === "isConnected") return () => false;
      if (prop === "on") return () => {};
      return () => null;
    },
  },
);

registerAllTools(
  transport,
  config,
  new Set(),
  probes,
  extClient,
  new ActivityLog(),
);

const current = transport.getSchemaSnapshot();
// Sort by name for stable diffs
current.sort((a, b) => a.name.localeCompare(b.name));

// ── Update mode: write snapshot and exit ─────────────────────────────────────

if (UPDATE) {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `[schema-audit] Snapshot updated: ${current.length} tools → ${SNAPSHOT_PATH}`,
  );
  process.exit(0);
}

// ── Diff mode ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.error(
    `[schema-audit] ERROR: No snapshot found at ${SNAPSHOT_PATH}\n` +
      `  Run with --update to generate it first:\n` +
      `    node scripts/audit-schema-changes.mjs --update`,
  );
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
baseline.sort((a, b) => a.name.localeCompare(b.name));

const baselineMap = new Map(baseline.map((t) => [t.name, t]));
const currentMap = new Map(current.map((t) => [t.name, t]));

const warnings = [];
const errors = [];

// Check for removed tools
for (const { name } of baseline) {
  if (!currentMap.has(name)) {
    errors.push(`REMOVED tool: "${name}"`);
  }
}

// Check for added tools (informational)
for (const { name } of current) {
  if (!baselineMap.has(name)) {
    warnings.push(`ADDED tool: "${name}" (additive, no action required)`);
  }
}

// Check for schema changes on existing tools
for (const curr of current) {
  const base = baselineMap.get(curr.name);
  if (!base) continue; // new tool — already warned above

  const baseRequired = new Set(base.inputSchema?.required ?? []);
  const currRequired = new Set(curr.inputSchema?.required ?? []);

  // Removed required params → breaking
  for (const param of baseRequired) {
    if (!currRequired.has(param)) {
      errors.push(`REMOVED required param "${param}" from tool "${curr.name}"`);
    }
  }

  // Added required params → breaking (callers lacking the new param will fail)
  for (const param of currRequired) {
    if (!baseRequired.has(param)) {
      errors.push(
        `ADDED required param "${param}" to tool "${curr.name}" (callers must update)`,
      );
    }
  }

  // Removed properties (input schema)
  const baseProps = Object.keys(base.inputSchema?.properties ?? {});
  const currProps = new Set(Object.keys(curr.inputSchema?.properties ?? {}));
  for (const prop of baseProps) {
    if (!currProps.has(prop)) {
      errors.push(`REMOVED input param "${prop}" from tool "${curr.name}"`);
    }
  }

  // Added properties → additive, just warn
  for (const prop of Object.keys(curr.inputSchema?.properties ?? {})) {
    if (!baseProps.includes(prop)) {
      warnings.push(
        `ADDED input param "${prop}" to tool "${curr.name}" (additive)`,
      );
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (!QUIET) {
  if (warnings.length > 0) {
    console.log(`\n[schema-audit] Additive changes (${warnings.length}):`);
    for (const w of warnings) console.log(`  ⚠  ${w}`);
  }

  if (errors.length > 0) {
    console.error(`\n[schema-audit] BREAKING CHANGES (${errors.length}):`);
    for (const e of errors) console.error(`  ✗  ${e}`);
    console.error(
      `\n  → Add an entry to ${CHANGELOG_PATH} documenting the change,\n` +
        `    then run: node scripts/audit-schema-changes.mjs --update\n` +
        `    to update the baseline snapshot.\n`,
    );
    process.exit(1);
  }
}

const total = current.length;
const added = warnings.filter((w) => w.startsWith("ADDED tool")).length;
const addedParams = warnings.filter((w) => w.startsWith("ADDED input")).length;
if (!QUIET)
  console.log(
    `[schema-audit] OK — ${total} tools, ${added} new tools, ${addedParams} new params, 0 breaking changes`,
  );
process.exit(0);
