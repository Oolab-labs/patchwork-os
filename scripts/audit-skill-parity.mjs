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

/**
 * Tool names the bridge actually registers, read from the BUILT output.
 *
 * Why this check exists: `ide-refactor` instructed the model to call
 * `createSnapshot` and `restoreSnapshot` for its rollback. Neither tool has
 * ever existed. The skill's own description promised "rolls back automatically
 * if anything breaks", so a user got a refactor with no safety net at all and
 * a closing report telling them a snapshot was available.
 *
 * Nothing caught it because a skill is prose — it is never compiled, never
 * imported, and never type-checked. This is the only place a wrong tool name
 * can be noticed before a user hits it.
 *
 * Returns null when dist/ is absent, and the check is then SKIPPED rather than
 * failed: a missing build is a local-workflow state, not a broken skill.
 */
function registeredTools() {
  const dir = path.join(root, "dist/tools");
  if (!existsSync(dir)) return null;
  const names = new Set();
  const NAME_RE = /name:\s*"([a-zA-Z][a-zA-Z0-9_]{2,40})"/g;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) {
        for (const m of readFileSync(full, "utf8").matchAll(NAME_RE))
          names.add(m[1]);
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return names.size > 0 ? names : null;
}

/**
 * Identifiers in a SKILL.md that are shaped like a bridge tool call.
 *
 * Conservative on purpose: only backticked camelCase starting with a known
 * verb prefix. Prose like `package.json` or `--flag` is not a tool, and a
 * false positive here would train people to ignore the gate.
 */
const TOOL_VERB =
  /^(get|set|run|find|go|search|apply|create|open|list|watch|explain|refactor|rename|format|organize|preview|capture|batch|clear|save|close|evaluate|start|stop|detect|generate|begin|commit|rollback|stage|restore|diff)[A-Z]/;

function toolLikeIdentifiers(text) {
  const out = new Map();
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/`([a-z][a-zA-Z0-9]{3,40})`/g)) {
      const id = m[1];
      if (TOOL_VERB.test(id) && !out.has(id)) out.set(id, i + 1);
    }
  });
  return out;
}

function main() {
  const local = skillsIn(TREES.local);
  const plugin = skillsIn(TREES.plugin);
  const shared = local.filter((n) => plugin.includes(n));
  const pluginOnly = plugin.filter((n) => !local.includes(n));
  const localOnly = local.filter((n) => !plugin.includes(n));

  // Tool-existence check across BOTH trees.
  const real = registeredTools();
  const unknownTools = [];
  if (real) {
    for (const [tree, dir] of Object.entries(TREES)) {
      for (const name of skillsIn(dir)) {
        const file = path.join(dir, name, "SKILL.md");
        for (const [id, line] of toolLikeIdentifiers(
          readFileSync(file, "utf8"),
        )) {
          if (!real.has(id)) unknownTools.push({ tree, name, id, line });
        }
      }
    }
  }

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

  if (!real) {
    // A SKIPPED check that exits 0 is indistinguishable from a check that
    // passed, and this one skipped in CI for its entire life: `dist/` is
    // gitignored and the job that runs this script did `npm ci` with no
    // build, so `knownToolNames()` returned null on every run and the
    // tool-existence half — the reason the gate exists — never executed once.
    // The green tick was reporting the skip.
    //
    // Locally a skip is legitimate (running the gate before a build is a
    // reasonable thing to do), so it stays a note there. Under CI it is a
    // hard failure, which is what makes the build step in ci.yml load-bearing
    // rather than a comment somebody can drop.
    if (process.env.CI) {
      console.error(
        "\n[skill-parity] FAIL — dist/ is not built, so the tool-existence\n" +
          "check could not run. Under CI that is a failure, not a note: this\n" +
          "gate silently skipped its main check on every CI run for its entire life.\n\n" +
          "  Add `npm run build` to the job before this step.\n",
      );
      process.exit(1);
    }
    console.log(
      "[skill-parity] NOTE dist/ not built — tool-existence check skipped.",
    );
  } else {
    console.log(
      `[skill-parity] ${real.size} registered tools · tool references checked`,
    );
  }

  if (unknownTools.length > 0) {
    console.error(
      `\n[skill-parity] FAIL — ${unknownTools.length} reference(s) to tools the bridge does not register:\n`,
    );
    for (const u of unknownTools) {
      console.error(`  ${u.tree}/${u.name}/SKILL.md:${u.line}  \`${u.id}\``);
    }
    console.error(
      "\nA skill is prose — it is never compiled, so a wrong tool name reaches a\n" +
        "user as a silently skipped step. Check the name against the registry, or\n" +
        "rewrite the step around a tool that exists.\n",
    );
    process.exit(1);
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
