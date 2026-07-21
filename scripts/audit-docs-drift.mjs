/**
 * Docs-drift guard (Track B3, resultmaxxing pass 2026-07).
 *
 * Sibling to audit-docs-wired.mjs (#850/#1012), which checks that documented
 * features actually exist in code ("documented ⇒ wired"). This script checks
 * the opposite failure mode: numeric claims in the docs going STALE relative
 * to a moving ground truth — a tool count creeping up without the doc being
 * updated, or a coverage threshold changing (e.g. a vitest major-version
 * re-baseline) without CLAUDE.md's copy being touched.
 *
 * ADVISORY ONLY — this script never fails CI (always exits 0). Drift here is
 * a documentation-hygiene issue, not a correctness break; a hard gate would
 * fight routine threshold-tuning PRs. It exists purely to surface drift in
 * a scannable place instead of silently rotting.
 *
 * Checks:
 *   1. Tool count — CLAUDE.md's "N tools registered" claim (documents/
 *      platform-docs.md reference line) vs. the actual registered-tool count,
 *      computed the same way audit-lsp-tools.mjs computes its Stats line
 *      (every distinct tool `name` seen in the built tool-schema exports).
 *   2. Coverage thresholds — CLAUDE.md's "Coverage gates: X% lines, Y%
 *      branches, Z% functions" claim vs. the actual `thresholds` block in
 *      vitest.config.ts.
 *
 * Usage: node scripts/audit-docs-drift.mjs
 * Exit code: always 0. Non-zero only on a script bug (file not found, etc).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

const drift = [];
const notes = [];

// ── 1. Tool count ────────────────────────────────────────────────────────────

function auditToolCount() {
  let statsLine;
  try {
    // audit-lsp-tools.mjs already computes and prints the authoritative
    // "Stats: N slim tools · ... · M total registered · ..." line — reuse it
    // rather than re-deriving the registered-tool set a second way.
    statsLine = execSync("node scripts/audit-lsp-tools.mjs", {
      cwd: root,
      encoding: "utf8",
    });
  } catch (err) {
    // audit-lsp-tools.mjs failing is that script's job to report; don't mask
    // it, but don't crash this advisory pass either.
    drift.push(
      `tool-count: could not run audit-lsp-tools.mjs to get ground truth (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  const m = statsLine.match(/(\d+)\s+total registered/);
  if (!m) {
    drift.push(
      "tool-count: could not parse 'N total registered' from audit-lsp-tools.mjs Stats line — its output format may have changed.",
    );
    return;
  }
  const actual = Number(m[1]);

  const claude = read("CLAUDE.md");
  const claudeMatch = claude.match(/\((\d+)\s+tools registered\)/);
  if (claudeMatch && Number(claudeMatch[1]) !== actual) {
    drift.push(
      `tool-count: CLAUDE.md claims ${claudeMatch[1]} tools registered; actual is ${actual} (per audit-lsp-tools.mjs Stats line). Update CLAUDE.md's platform-docs.md reference line.`,
    );
  } else if (claudeMatch) {
    notes.push(
      `tool-count: CLAUDE.md's ${claudeMatch[1]} matches actual ${actual}`,
    );
  } else {
    notes.push(
      "tool-count: could not find a 'N tools registered' claim in CLAUDE.md to check (informational — not necessarily a problem).",
    );
  }

  const platformDocs = read("documents/platform-docs.md");
  const platformMatch = platformDocs.match(/(\d+)\s+tools\s+·/);
  if (platformMatch && Number(platformMatch[1]) !== actual) {
    drift.push(
      `tool-count: documents/platform-docs.md's banner claims ${platformMatch[1]} tools; actual is ${actual}. Update the banner line.`,
    );
  } else if (platformMatch) {
    notes.push(
      `tool-count: platform-docs.md banner (${platformMatch[1]}) matches actual ${actual}`,
    );
  }
}

// ── 2. Coverage thresholds ───────────────────────────────────────────────────

function auditCoverageThresholds() {
  const vitestConfig = read("vitest.config.ts");
  const linesMatch = vitestConfig.match(/lines:\s*(\d+)/);
  const branchesMatch = vitestConfig.match(/branches:\s*(\d+)/);
  const functionsMatch = vitestConfig.match(/functions:\s*(\d+)/);
  if (!linesMatch || !branchesMatch || !functionsMatch) {
    drift.push(
      "coverage: could not parse lines/branches/functions thresholds out of vitest.config.ts — its shape may have changed.",
    );
    return;
  }
  const actual = {
    lines: Number(linesMatch[1]),
    branches: Number(branchesMatch[1]),
    functions: Number(functionsMatch[1]),
  };

  const claude = read("CLAUDE.md");
  const claudeMatch = claude.match(
    /Coverage gates:\s*(\d+)%\s*lines,\s*(\d+)%\s*branches,\s*(\d+)%\s*functions/,
  );
  if (!claudeMatch) {
    notes.push(
      "coverage: could not find a 'Coverage gates: X% lines, Y% branches, Z% functions' claim in CLAUDE.md to check.",
    );
    return;
  }
  const documented = {
    lines: Number(claudeMatch[1]),
    branches: Number(claudeMatch[2]),
    functions: Number(claudeMatch[3]),
  };
  const mismatched =
    documented.lines !== actual.lines ||
    documented.branches !== actual.branches ||
    documented.functions !== actual.functions;
  if (mismatched) {
    drift.push(
      `coverage: CLAUDE.md claims ${documented.lines}/${documented.branches}/${documented.functions} ` +
        `(lines/branches/functions); vitest.config.ts's actual thresholds are ` +
        `${actual.lines}/${actual.branches}/${actual.functions}. Update CLAUDE.md's "Coverage gates" line ` +
        `(check vitest.config.ts's inline comment first — a mismatch here is often an intentional ` +
        `re-baseline, e.g. a vitest major-version coverage-counting change, not a real coverage drop).`,
    );
  } else {
    notes.push(
      `coverage: CLAUDE.md's ${documented.lines}/${documented.branches}/${documented.functions} matches vitest.config.ts`,
    );
  }
}

// ── 3. Plugin API drift ──────────────────────────────────────────────────────
//
// Session-review finding: documents/plugin-authoring.md and
// documents/live-toolsmithing.md both documented an imperative
// `ctx.registerTool()` API for plugin authors, but PluginContext
// (src/plugin.ts) never implemented it — a plugin author following that
// documented pattern got `ctx.registerTool is not a function` and their
// plugin was silently skipped (see src/__tests__/pluginLoader.test.ts's
// regression test pinning that failure). Docs were fixed to describe only
// the actually-supported return-value shape (`register(ctx)` returns
// `{ tools: [...] }`); this check keeps that fix from silently regressing
// if `ctx.registerTool` — or `PluginContext`'s `registerTool` — is
// reintroduced into docs without ever landing in the real type.

function auditPluginApiDrift() {
  const pluginSrc = read("src/plugin.ts");
  const hasRegisterToolMethod = /\bregisterTool\s*\(/.test(pluginSrc);

  for (const doc of [
    "documents/plugin-authoring.md",
    "documents/live-toolsmithing.md",
  ]) {
    const text = read(doc);
    const mentionsRegisterTool = /\bregisterTool\s*\(/.test(text);
    if (mentionsRegisterTool && !hasRegisterToolMethod) {
      drift.push(
        `plugin-api: ${doc} mentions "registerTool(" but src/plugin.ts's PluginContext does not implement a registerTool method — this describes an API that does not exist. Either implement PluginContext.registerTool, or remove/rewrite the doc example to use the return-value \`register(ctx) => { tools: [...] }\` shape (the only currently-supported contract).`,
      );
    } else if (mentionsRegisterTool) {
      notes.push(
        `plugin-api: ${doc} mentions "registerTool(" and src/plugin.ts now implements it — docs and code agree.`,
      );
    }
  }
  if (drift.every((d) => !d.startsWith("plugin-api:"))) {
    notes.push(
      "plugin-api: no documented-but-nonexistent registerTool() reference found",
    );
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

auditToolCount();
auditCoverageThresholds();
auditPluginApiDrift();

for (const n of notes) console.log(`  ℹ ${n}`);
if (drift.length > 0) {
  console.log("\n⚠ docs-drift found (advisory only, does not fail CI):\n");
  for (const d of drift) console.log(`  • ${d}`);
} else {
  console.log("\n✓ no docs drift found");
}
// Always exit 0 — see file header for why this is advisory-only.
process.exit(0);
