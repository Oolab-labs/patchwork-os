/**
 * Skill-parity gate.
 *
 * `.claude/skills/` and `claude-ide-bridge-plugin/skills/` hold same-named
 * SKILL.md files that are STANDALONE COPIES, not symlinks. CLAUDE.md says so
 * and asks the next person to sync them by hand:
 *
 *   "No symlinks: Files in claude-ide-bridge-plugin/ are standalone copies...
 *    After modifying plugin source, manually sync copies — they will NOT
 *    auto-update."
 *
 * That is a rule which depends on being remembered, and it was not. Commit
 * 339dda40 added the `refactorAnalyze` → `refactorPreview` risk workflow to
 * the PLUGIN copy of `ide-refactor` and left `.claude/skills/` on the old
 * single-step version — so the skill that actually loads in this repository
 * skipped the risk analysis that CLAUDE.md mandates, and nothing noticed for
 * as long as it took someone to diff the two trees by hand.
 *
 * CI already validates the plugin skills directory (frontmatter, required
 * fields). It has never compared the two trees. This does.
 *
 * ## What is and is not enforced
 *
 * ENFORCED: any skill present in BOTH trees must be byte-identical.
 *
 * NOT ENFORCED: that both trees contain the same SET of skills. The plugin
 * ships several skills that `.claude/skills/` deliberately does not
 * (`ide-monitor`, `ide-dead-code-hunter`, …), because adding one there changes
 * what loads in every session in this repository. That is a judgment call per
 * skill, not a parity violation — so plugin-only skills are REPORTED and do
 * not fail the build. A gate that failed on them would push someone toward
 * copying skills in just to go green.
 *
 * Usage:  node scripts/audit-skill-parity.mjs
 * Exit:   0 clean · 1 drift · 2 script error
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const TREES = {
  local: path.join(root, ".claude/skills"),
  plugin: path.join(root, "claude-ide-bridge-plugin/skills"),
};

function skillsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(path.join(dir, n, "SKILL.md")))
    .sort();
}

/** First differing line, for an actionable message rather than "they differ". */
function firstDifference(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return {
        line: i + 1,
        local: (la[i] ?? "(end of file)").trim().slice(0, 90),
        plugin: (lb[i] ?? "(end of file)").trim().slice(0, 90),
      };
    }
  }
  return null;
}

function main() {
  const local = skillsIn(TREES.local);
  const plugin = skillsIn(TREES.plugin);
  const shared = local.filter((n) => plugin.includes(n));
  const pluginOnly = plugin.filter((n) => !local.includes(n));
  const localOnly = local.filter((n) => !plugin.includes(n));

  const drifted = [];
  for (const name of shared) {
    const a = readFileSync(path.join(TREES.local, name, "SKILL.md"), "utf8");
    const b = readFileSync(path.join(TREES.plugin, name, "SKILL.md"), "utf8");
    if (a !== b) drifted.push({ name, diff: firstDifference(a, b) });
  }

  console.log(
    `[skill-parity] ${shared.length} shared skill(s) compared · ` +
      `${pluginOnly.length} plugin-only · ${localOnly.length} local-only`,
  );
  for (const n of pluginOnly) {
    console.log(
      `[skill-parity] NOTE plugin-only: ${n} (not in .claude/skills — deliberate unless someone says otherwise)`,
    );
  }
  for (const n of localOnly) {
    console.log(
      `[skill-parity] NOTE local-only: ${n} (not shipped in the plugin)`,
    );
  }

  if (drifted.length === 0) {
    console.log("[skill-parity] OK — every shared skill is identical.");
    process.exit(0);
  }

  console.error(
    `\n[skill-parity] FAIL — ${drifted.length} skill(s) differ between the two trees:\n`,
  );
  for (const d of drifted) {
    console.error(`  ${d.name}  (first difference at line ${d.diff?.line})`);
    console.error(`    .claude/skills : ${d.diff?.local}`);
    console.error(`    plugin         : ${d.diff?.plugin}`);
  }
  console.error(
    "\nThese are standalone copies, not symlinks. Decide which is correct and\n" +
      "make them identical — do not assume the plugin copy is newer; check\n" +
      "`git log` for both paths.\n",
  );
  process.exit(1);
}

main();
