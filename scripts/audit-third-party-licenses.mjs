/**
 * Third-party licence inventory — generator and gate.
 *
 * Default: verify `LICENSE-THIRD-PARTY.md` still matches the production
 * dependency set in every tracked lockfile, and that no dependency carries a
 * licence this project cannot accept.
 *
 * `--write`: regenerate the file.
 *
 * ## Why this exists
 *
 * `LICENSE-THIRD-PARTY.md` was three lines, covering the connector glyphs and
 * nothing else, while the four workspaces ship 327 production packages between
 * them. An MIT project that asserts an open-core boundary and publishes a
 * threat model needs its INBOUND licence position to be as legible as its
 * outbound one — the obligations run both ways, and "we are MIT" says nothing
 * about what is vendored underneath.
 *
 * ## Read from the lockfile, not from node_modules
 *
 * Every production entry in all four lockfiles carries a `license` field, so
 * this works offline and needs no install. That matters: CI runs `npm ci` at
 * the repository root only, so anything requiring `node_modules` in
 * `dashboard/`, `services/push-relay/` or `vscode-extension/` would silently
 * cover one workspace of four — which is exactly how the CVE gate came to
 * audit a quarter of the project.
 *
 * ## What fails the build
 *
 * A production dependency whose licence is strong copyleft (GPL, AGPL, SSPL,
 * or LGPL) and is not offered under an alternative. Those impose obligations
 * this project has not accepted, and finding one AFTER a release is expensive.
 * A dual licence like `(BSD-3-Clause OR GPL-2.0)` is fine: the permissive
 * option is available and is the one taken.
 *
 * A missing `license` field is reported and does NOT fail, because the field
 * being absent from a lockfile does not mean the package is unlicensed — it
 * usually means the metadata predates the convention. It is listed as
 * `UNDECLARED` so it stays visible instead of being silently omitted.
 *
 * ## What this is not
 *
 * It is not legal advice, it does not read LICENSE files to check the
 * declaration is true, and it does not detect a package whose declared licence
 * differs from its actual terms. It answers one question mechanically: what do
 * we depend on, and what does each one say it is.
 *
 * Usage:  node scripts/audit-third-party-licenses.mjs [--write]
 * Exit:   0 clean · 1 stale inventory or unacceptable licence · 2 script error
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const INVENTORY = "LICENSE-THIRD-PARTY.md";

/**
 * One SPDX identifier — NOT an expression — that carries strong copyleft.
 * Anchored on purpose: it is only ever handed a single term by `isCopyleft`.
 */
const COPYLEFT_ID = /^(AGPL|GPL|LGPL|SSPL)(-|$)/i;

/**
 * Does this SPDX expression impose copyleft that cannot be avoided?
 *
 * The previous test applied `/^\s*(AGPL|GPL|LGPL|SSPL)[^)]*$/i` to the WHOLE
 * expression. It caught `GPL-3.0-only` and correctly ignored
 * `(BSD-3-Clause OR GPL-2.0)`, but it also ignored `Apache-2.0 AND
 * LGPL-3.0-or-later` — four shipped packages declare exactly that — because
 * the copyleft term was not written first. Whether the gate fired depended on
 * operand order.
 *
 * What fixes that is parsing the expression, not rewriting the regex: the
 * identifier test below is still start-anchored, and reverting it to the old
 * pattern changes no result, because it is now only ever applied to a single
 * term. Probed, not assumed — the mutation was run and every count held. The
 * load-bearing change is the AND/OR split.
 *
 * The rule it implements is the SPDX one:
 *
 *   - `A OR B` — a choice. Clean if ANY alternative is copyleft-free, because
 *     the permissive option is available and is the one taken.
 *   - `A AND B` — cumulative. Copyleft if ANY term is copyleft.
 *
 * `WITH` (exception clauses) is deliberately left attached to its identifier:
 * `GPL-2.0-only WITH Classpath-exception-2.0` is still a GPL obligation with a
 * carve-out, and deciding whether that carve-out is enough is a judgement for
 * the allowlist, not for a regex.
 */
function isCopyleft(expression) {
  const expr = String(expression).trim();
  if (!expr || expr === "UNDECLARED") return false;
  // Strip only fully-enclosing parentheses; nested groups fall through to the
  // conservative per-term test below rather than being mis-parsed.
  const bare = /^\((.*)\)$/s.exec(expr)?.[1] ?? expr;
  const alternatives = bare.split(/\s+OR\s+/i);
  // Clean when at least one alternative is entirely copyleft-free.
  return !alternatives.some(
    (alt) => !alt.split(/\s+AND\s+/i).some((term) => COPYLEFT_ID.test(term)),
  );
}

function trackedLockfiles() {
  return execFileSync("git", ["ls-files", "*package-lock.json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .sort();
}

/**
 * Advisories accepted for now. Every entry needs a written reason.
 *
 * Deliberately shaped like the CVE gate's allowlist: an entry that does not
 * say WHY is not an accepted risk, it is an unexamined one, so a missing or
 * empty `reason` is a hard error rather than a default.
 */
function loadAllowlist() {
  const file = path.join(root, "scripts/audit-third-party-licenses-allow.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[licenses] allowlist unreadable: ${err.message}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed.allow)) {
    console.error("[licenses] allowlist: `allow` must be an array");
    process.exit(2);
  }
  for (const [i, e] of parsed.allow.entries()) {
    if (!e?.name || !e?.license || !String(e.reason ?? "").trim()) {
      console.error(
        `[licenses] allowlist entry #${i + 1} needs name, license and a non-empty reason.`,
      );
      process.exit(2);
    }
  }
  return parsed.allow;
}

/**
 * True when this exact package+licence pair has a recorded, reasoned
 * acceptance. Matched on BOTH fields: a package silently changing licence
 * between versions must re-surface rather than inherit its own exemption.
 */
function isAllowed(allow, pkg) {
  return allow.some((e) => e.name === pkg.name && e.license === pkg.license);
}

/** Production (non-dev) packages from one lockfile, optional ones included. */
function productionPackages(lockPath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(path.join(root, lockPath), "utf8"));
  } catch (err) {
    console.error(`[licenses] cannot read ${lockPath}: ${err.message}`);
    process.exit(2);
  }
  const out = [];
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    // `optional` used to be skipped alongside `dev`, which put 131 packages
    // outside the gate entirely — 14 of them LGPL-3.0-or-later. An optional
    // dependency is INSTALLED by default; npm only omits it on
    // `--omit=optional` or when its platform does not match. So its terms ship
    // in the deployed artifact, and skipping it reported a copyleft-free
    // production tree while copyleft binaries were in it.
    if (meta.dev) continue;
    out.push({
      name: key.slice("node_modules/".length),
      version: meta.version ?? "?",
      license: meta.license ? String(meta.license) : "UNDECLARED",
      optional: Boolean(meta.optional),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function collect() {
  return trackedLockfiles().map((lockPath) => ({
    workspace:
      path.dirname(lockPath) === "." ? "(root)" : path.dirname(lockPath),
    lockPath,
    packages: productionPackages(lockPath),
  }));
}

function render(workspaces) {
  const total = workspaces.reduce((n, w) => n + w.packages.length, 0);
  const all = workspaces.flatMap((w) => w.packages);
  const byLicence = new Map();
  for (const p of all)
    byLicence.set(p.license, (byLicence.get(p.license) ?? 0) + 1);

  const lines = [
    "# Third-Party Licences",
    "",
    "<!-- GENERATED by scripts/audit-third-party-licenses.mjs — do not edit by hand.",
    "     Regenerate with: node scripts/audit-third-party-licenses.mjs --write -->",
    "",
    "Every **production** dependency of every workspace in this repository, with",
    "the licence each one declares. Development dependencies are excluded: they",
    "are not distributed, and including them would bury the list that matters in",
    "one that does not.",
    "",
    "Read from the lockfiles, so this is the set actually resolved rather than the",
    "set requested. `UNDECLARED` means the package publishes no `license` field —",
    "not that it is unlicensed; check the package itself before relying on it.",
    "",
    `**${total} production packages** across ${workspaces.length} workspaces.`,
    "",
    "## Licences in use",
    "",
    "| Licence | Packages |",
    "|---|---|",
  ];
  for (const [lic, n] of [...byLicence].sort((a, b) => b[1] - a[1]))
    lines.push(`| ${lic} | ${n} |`);

  lines.push(
    "",
    "## By workspace",
    "",
    "<details>",
    "<summary>Full inventory</summary>",
    "",
  );
  for (const w of workspaces) {
    lines.push(`### ${w.workspace} — ${w.packages.length} packages`, "");
    lines.push("| Package | Version | Licence |", "|---|---|---|");
    for (const p of w.packages)
      lines.push(`| ${p.name} | ${p.version} | ${p.license} |`);
    lines.push("");
  }
  lines.push("</details>", "");

  lines.push(
    "## Assets",
    "",
    "Connector glyphs: [SimpleIcons](https://simpleicons.org/), CC0-1.0.",
    "",
    "## Scope",
    "",
    "This is a mechanical inventory, not legal advice. It records what each",
    "package declares; it does not verify the declaration against the package's",
    "own LICENSE file, and it does not cover assets, fonts or vendored code that",
    "arrives outside npm.",
    "",
  );
  return lines.join("\n");
}

function main() {
  const write = process.argv.includes("--write");
  const workspaces = collect();
  const generated = render(workspaces);

  // Unacceptable licences first: a stale inventory is untidy, a copyleft
  // production dependency is a problem regardless of what the file says.
  const allow = loadAllowlist();
  const copyleft = workspaces.flatMap((w) =>
    w.packages
      .filter((p) => isCopyleft(p.license))
      .map((p) => ({ ...p, workspace: w.workspace })),
  );
  const bad = copyleft.filter((p) => !isAllowed(allow, p));
  const accepted = copyleft.filter((p) => isAllowed(allow, p));
  const undeclared = workspaces.flatMap((w) =>
    w.packages
      .filter((p) => p.license === "UNDECLARED")
      .map((p) => ({ ...p, workspace: w.workspace })),
  );

  const total = workspaces.reduce((n, w) => n + w.packages.length, 0);
  console.log(
    `[licenses] ${total} production packages across ${workspaces.length} workspace(s).`,
  );
  for (const u of undeclared)
    console.log(
      `[licenses]   note: ${u.workspace}/${u.name}@${u.version} declares no licence — listed as UNDECLARED.`,
    );
  // Printed on every clean run on purpose. An accepted obligation that stops
  // being mentioned is one nobody re-examines, and the whole point of taking
  // these out of the failure list was to make them VISIBLE rather than absent.
  for (const a of accepted)
    console.log(
      `[licenses]   accepted: ${a.workspace}/${a.name}@${a.version} — ${a.license} (see scripts/audit-third-party-licenses-allow.json)`,
    );

  if (bad.length > 0) {
    console.error(
      `\n[licenses] FAIL — ${bad.length} copyleft production dependency(ies):\n`,
    );
    for (const b of bad)
      console.error(`  ${b.workspace}: ${b.name}@${b.version} — ${b.license}`);
    console.error(
      "\nThese impose obligations this project has not accepted. Replace the\n" +
        "dependency, move it to devDependencies if it is not distributed, or —\n" +
        "if the obligation is one this project is willing to carry — record it\n" +
        "in scripts/audit-third-party-licenses-allow.json with a written reason.\n" +
        "An entry with no reason is rejected: an unexplained exemption is an\n" +
        "unexamined risk, not an accepted one.\n",
    );
    process.exit(1);
  }

  if (write) {
    writeFileSync(path.join(root, INVENTORY), generated);
    console.log(`[licenses] wrote ${INVENTORY}.`);
    process.exit(0);
  }

  let current;
  try {
    current = readFileSync(path.join(root, INVENTORY), "utf8");
  } catch {
    console.error(`\n[licenses] FAIL — ${INVENTORY} is missing.\n`);
    process.exit(1);
  }

  if (current !== generated) {
    console.error(`\n[licenses] FAIL — ${INVENTORY} is stale.\n`);
    console.error(
      "  A production dependency was added, removed or changed version, and the\n" +
        "  inventory was not regenerated. Run:\n\n" +
        "      node scripts/audit-third-party-licenses.mjs --write\n",
    );
    process.exit(1);
  }

  // NOT "no copyleft dependencies" — there are 14, and saying otherwise on a
  // green run is the same class of lie as the skipped check that still
  // printed OK. The count is the point: it should be read, and it should be
  // noticed when it grows.
  console.log(
    accepted.length === 0
      ? "[licenses] OK — inventory current, no copyleft dependencies."
      : `[licenses] OK — inventory current; ${accepted.length} copyleft dependency(ies) accepted with recorded reasons, none unreviewed.`,
  );
  process.exit(0);
}

main();
