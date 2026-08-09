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
 * GATING since 2026-08. It was advisory — "always exits 0" — on the reasoning
 * that a hard gate would fight routine threshold-tuning PRs. The reasoning was
 * sound and the outcome was not: while it reported "no docs drift found", 13
 * tracked files carried a tool count two releases stale, including a licensing
 * statement and the plugin README a user reads first. It only ever looked at
 * CLAUDE.md and the platform-docs banner, so the two files somebody remembered
 * to check were the two it checked.
 *
 * An advisory check on a number nobody re-derives by hand is a check nobody
 * reads. The threshold-tuning worry is handled by the allowlist instead: an
 * exception costs one line and a reason, which is cheaper than the drift.
 *
 * Checks:
 *   1. Tool count — EVERY tracked markdown file's "N tools" claim vs. the
 *      actual registered-tool count,
 *      computed the same way audit-lsp-tools.mjs computes its Stats line
 *      (every distinct tool `name` seen in the built tool-schema exports).
 *   2. Coverage thresholds — CLAUDE.md's "Coverage gates: X% lines, Y%
 *      branches, Z% functions" claim vs. the actual `thresholds` block in
 *      vitest.config.ts.
 *
 * Usage: node scripts/audit-docs-drift.mjs
 * Exit:  0 clean · 1 drift found · 2 script error
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

  // Every tracked markdown file, not the two somebody thought to list. A
  // count is claimed in 20+ places and re-derived by hand in none of them.
  auditToolCountAcrossDocs(actual);

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

/**
 * Documents whose numbers are a record of what was true when they were
 * written. Updating them would be falsifying a record, not fixing drift.
 */
const HISTORICAL = [
  /^CHANGELOG\.md$/,
  /^docs\/dogfood\//, // dated dogfood reports
  /^docs\/plans\//, // point-in-time plans
  /-\d{4}-\d{2}-\d{2}\.md$/, // anything stamped with its own date
];

/**
 * Phrases that assert the WHOLE tool surface, as opposed to counting a subset.
 *
 * Matching a bare "N tools" was the first attempt and it was unusable: "15
 * tools for LSP navigation" is a correct statement about a subset, and there
 * are dozens. The claim this gate is for is "this is how many tools there
 * are", which in practice is written one of these five ways.
 *
 * Limitation, stated rather than hidden: a stale SUBSET count is invisible to
 * this. `audit-business-content.mjs` makes the same kind of trade-off and says
 * so — a check that fires constantly on correct text gets switched off, and
 * then it guards nothing.
 */
const FULL_SURFACE_CLAIM = [
  /\ball\s+(\d{2,4})(\+?)\s+tools\b/g,
  /\b(\d{2,4})(\+?)\s+tools\s+(?:are\s+)?registered\b/g,
  /\bregisters?\s+(\d{2,4})(\+?)\s+tools\b/g,
  /\bprovid(?:es|ing)\s+(\d{2,4})(\+?)\s+tools\b/g,
  /\b(\d{2,4})(\+?)\s+tools\s+per\s+`?documents\/platform-docs/g,
];

function auditToolCountAcrossDocs(actual) {
  let slim = 0;
  try {
    const stats = execSync("node scripts/audit-lsp-tools.mjs", {
      cwd: root,
      encoding: "utf8",
    });
    slim = Number(stats.match(/(\d+)\s+slim tools/)?.[1] ?? 0);
  } catch {
    // The caller already reported an unusable Stats line.
  }

  const files = execSync("git ls-files '*.md'", {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !HISTORICAL.some((re) => re.test(f)));

  const seen = new Set();
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const re of FULL_SURFACE_CLAIM) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const n = Number(m[1]);
          const approx = m[2] === "+";
          if (n === actual || n === slim) continue;
          // "170+ tools" stays true as the real count grows past it.
          if (approx && n <= actual) continue;
          // One line can match two patterns ("all 177 tools" and "177 tools
          // are registered" are the same claim). Report the line once.
          const key = `${file}:${i + 1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          drift.push(
            `tool-count: ${key} claims "${m[0].trim()}" — actual is ${actual}` +
              (slim ? ` (slim ${slim})` : ""),
          );
        }
      }
    });
  }
}

/**
 * The documented default for `approvalGate` must match the code.
 *
 * `documents/architecture.md` claimed every outbound action passes through the
 * policy gate as a "structural invariant". Human approval does not: the gate
 * defaults to "off" and returns `allow` before any tier check. An operator
 * reading that sentence would believe a default install asks before acting.
 *
 * The sentence is fixed. This is here so the SAME sentence cannot go stale the
 * other way — flip the default in config.ts and the doc silently becomes wrong
 * again, in the direction that overstates safety. Cheap to check, and the
 * failure mode is a security claim, which is the kind worth spending a gate on.
 */
function auditApprovalGateDefault() {
  const config = read("src/config.ts");
  const m =
    /approvalGate\?:\s*"off"\s*\|\s*"high"\s*\|\s*"all"\s*\}\)\.approvalGate\s*\?\?\s*"(\w+)"/.exec(
      config,
    );
  if (!m) {
    drift.push(
      "approval-gate: could not read the approvalGate default from src/config.ts — this check needs updating, not deleting.",
    );
    return;
  }
  const actual = m[1];
  const doc = read("documents/architecture.md");
  const claimed = /`approvalGate`\s+defaults\s+to\s+`"(\w+)"`/.exec(doc);
  if (!claimed) {
    drift.push(
      "approval-gate: documents/architecture.md no longer states the approvalGate default. It described the gate as a structural invariant while human approval was off by default; the statement of the real default must stay.",
    );
    return;
  }
  if (claimed[1] !== actual) {
    drift.push(
      `approval-gate: documents/architecture.md says the default is "${claimed[1]}", src/config.ts says "${actual}".`,
    );
    return;
  }
  notes.push(
    `approval-gate: documented default "${actual}" matches src/config.ts`,
  );
}

// ── run ──────────────────────────────────────────────────────────────────────

auditToolCount();
auditApprovalGateDefault();
auditCoverageThresholds();
auditPluginApiDrift();

for (const n of notes) console.log(`  ℹ ${n}`);
if (drift.length > 0) {
  console.error(`\n✗ docs drift — ${drift.length} stale claim(s):\n`);
  for (const d of drift) console.error(`  • ${d}`);
  console.error(
    "\nUpdate the number, or add the file to HISTORICAL in this script if it\n" +
      "is a record of what was true at the time (a changelog entry).\n",
  );
  process.exit(1);
}
console.log("\n✓ no docs drift found");
process.exit(0);
