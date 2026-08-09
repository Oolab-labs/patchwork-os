/**
 * Every `patchwork <verb>` in tracked documentation must be a real verb.
 *
 * ## Why this exists
 *
 * The README's hero block — the second thing a new user runs, in a section
 * titled "90-second start" — said:
 *
 *     patchwork connections connect gmail
 *
 * There is no `connections` verb. The CLI answers
 * `Unknown command: 'connections'. Did you mean: connect?` and stops. Someone
 * following the quickstart hit that on their second command.
 *
 * Nothing could have caught it. The docs-drift gate checks numeric claims,
 * `audit-docs-wired` checks that documented FEATURES exist, and neither looks
 * at whether an advertised command dispatches. A wrong number in a doc is
 * embarrassing; a wrong command in the quickstart is the first impression.
 *
 * ## The verb list is read, not restated
 *
 * `KNOWN_SUBCOMMANDS` in `src/index.ts` is what the dispatcher itself matches
 * against — the same array that produces the "Did you mean" suggestion. Any
 * list maintained here would be a second copy that drifts, which is the bug
 * this repository keeps finding in itself.
 *
 * Read statically rather than by running the CLI: this needs no build, so it
 * cannot silently pass by checking a stale `dist/`.
 *
 * ## What is checked
 *
 * Fenced code blocks only. Prose says things like "the connections page" and
 * "patchwork will connect", and matching those produces noise that gets the
 * check switched off. A command in a fenced block is an instruction someone
 * will paste.
 *
 * Flags, paths and sub-verbs are ignored — only the FIRST word after
 * `patchwork` is checked. Whether `recipe run` is a valid sub-verb of `recipe`
 * is a deeper question this deliberately does not answer; the failure it
 * exists for is a top-level verb that does not exist at all.
 *
 * ## The help text is checked too
 *
 * `--help` advertised `start-orchestrator`; the verb is `orchestrator`. That is
 * worse than the README bug, because the binary's own help is where a reader
 * goes to check what the README told them. Same rule, same source of truth.
 *
 * Usage:  node scripts/audit-cli-commands.mjs
 * Exit:   0 clean · 1 unknown verb advertised · 2 script error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Documents that record what a command used to be. */
const HISTORICAL = [
  /^CHANGELOG\.md$/,
  /^docs\/migration\.md$/, // by definition documents older invocations
  /^docs\/dogfood\//,
  /^docs\/plans\//,
  /-\d{4}-\d{2}-\d{2}\.md$/,
];

/**
 * `patchwork <verb>` where it STARTS a command — at the beginning of a line,
 * after a `$` prompt, or after a shell operator.
 *
 * A bare `\bpatchwork\s+(\w+)` was the first attempt and it was unusable. It
 * matched `npm install -g patchwork-os typescript-language-server`, reporting
 * `typescript-language-server` as an unknown verb, and a diagram line reading
 * `launchd → patchwork bridge (node) → claude CLI`. Neither is something a
 * reader would paste. A check whose output is mostly its own noise gets
 * switched off, and then it guards nothing.
 */
const INVOCATION =
  /(?:^|[$;|]|&&|\|\|)\s*(?:npx\s+)?patchwork(?:-os)?(?:@[\w.-]+)?\s+([a-z][a-z0-9-]*)/g;

/**
 * Words that follow the binary name but are not verbs: global flags, and the
 * bare-binary forms. `--workspace` is documented as `patchwork --workspace .`,
 * which is correct and has no subcommand.
 */
const NOT_A_VERB = new Set(["is", "will", "can", "and", "or", "the", "to"]);

function knownSubcommands() {
  const src = readFileSync(path.join(root, "src/index.ts"), "utf8");
  const start = src.indexOf("const KNOWN_SUBCOMMANDS = [");
  if (start === -1) {
    console.error(
      "[cli-commands] could not find KNOWN_SUBCOMMANDS in src/index.ts — this check needs updating, not deleting.",
    );
    process.exit(2);
  }
  // Bracket-MATCHED. Taking the first `]` truncated the array at the first
  // comment containing one — `process.argv[2]` in an explanatory note — so two
  // real verbs fell outside the parse and the gate reported a working command
  // as unknown. Same shape as the CSS `blockFor` bug fixed in #1298: a scan
  // that stops at the first closing token silently sees less than it claims.
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("[", start); i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    console.error(
      "[cli-commands] KNOWN_SUBCOMMANDS has unbalanced brackets — cannot parse.",
    );
    process.exit(2);
  }
  // Comments stripped FIRST. The array carries an explanatory note that names
  // `"tools"` in prose, and without this the parser read the verb out of the
  // comment — so deleting the real entry changed nothing and the check went on
  // passing. A scan for the ABSENCE of something must never read the text that
  // describes it; `audit-a11y` learned the same lesson about CSS comments.
  const block = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const verbs = Array.from(block.matchAll(/"([a-z][a-z0-9-]*)"/g), (m) => m[1]);
  if (verbs.length < 5) {
    console.error(
      `[cli-commands] parsed only ${verbs.length} subcommands — the array shape changed.`,
    );
    process.exit(2);
  }
  return new Set(verbs);
}

function trackedMarkdown() {
  return execFileSync("git", ["ls-files", "*.md"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !HISTORICAL.some((re) => re.test(f)));
}

/** Lines inside ``` fences, with their 1-based line numbers. */
function fencedLines(text) {
  const out = [];
  let inFence = false;
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence) out.push({ line, n: i + 1 });
  });
  return out;
}

/**
 * Verbs advertised in the CLI's own `--help` output.
 *
 * Read statically from the help template in `src/index.ts` rather than by
 * running the binary — no build required, so this cannot pass against a stale
 * `dist/`. Help lines are `  <verb> [args]   Description`, two-space indented
 * inside a template literal.
 */
function helpTextVerbs() {
  const src = readFileSync(path.join(root, "src/index.ts"), "utf8");
  // ONLY the top-level help block. Scanning the whole file matched sub-verbs
  // — `recipe schema`, `recipe audit-env` — which are indented identically
  // inside their own sub-help and are not top-level verbs at all. A check
  // reporting `schema` as an unknown command is noise, and noise is how a
  // check gets deleted.
  const start = src.indexOf("`Get started\\n`");
  if (start === -1) {
    console.error(
      "[cli-commands] could not locate the top-level help block in src/index.ts — this check needs updating, not deleting.",
    );
    process.exit(2);
  }
  const end = src.indexOf("process.exit(0)", start);
  const block = src.slice(start, end === -1 ? src.length : end);
  const verbs = new Map();
  for (const m of block.matchAll(/`\s{2}([a-z][a-z0-9-]*)[\s[]/g)) {
    const verb = m[1];
    if (verb && !verbs.has(verb)) verbs.set(verb, m[0].trim());
  }
  return verbs;
}

function main() {
  const known = knownSubcommands();
  const files = trackedMarkdown();
  const bad = [];
  let checked = 0;

  for (const file of files) {
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const { line, n } of fencedLines(text)) {
      // A comment in a shell block is prose.
      const code = line.split("#")[0] ?? "";
      for (const m of code.matchAll(INVOCATION)) {
        const verb = m[1];
        if (!verb || verb.startsWith("-") || NOT_A_VERB.has(verb)) continue;
        checked++;
        if (!known.has(verb)) bad.push({ file, n, verb, line: line.trim() });
      }
    }
  }

  // The binary's own help. A reader who doubts the README checks `--help`,
  // so an unknown verb there is the more expensive of the two.
  const helpBad = [];
  for (const [verb, line] of helpTextVerbs()) {
    if (!known.has(verb)) helpBad.push({ verb, line });
  }

  console.log(
    `[cli-commands] ${checked} invocation(s) in ${files.length} tracked markdown files · ${known.size} known verbs`,
  );

  if (helpBad.length > 0) {
    console.error(
      `\n[cli-commands] FAIL — ${helpBad.length} verb(s) advertised in --help that do not dispatch:\n`,
    );
    for (const b of helpBad) console.error(`  ${b.verb}\n    ${b.line}`);
    console.error(
      "\nsrc/index.ts advertises it and the dispatcher does not know it.\n",
    );
    process.exit(1);
  }

  if (bad.length === 0) {
    console.log("[cli-commands] OK — every advertised command exists.");
    process.exit(0);
  }

  console.error(`\n[cli-commands] FAIL — ${bad.length} unknown verb(s):\n`);
  for (const b of bad) {
    console.error(`  ${b.file}:${b.n}  patchwork ${b.verb}\n    ${b.line}`);
  }
  console.error(
    "\nThe verb does not exist, so this command fails for anyone who runs it.\n" +
      "Fix the doc, or add the subcommand. `KNOWN_SUBCOMMANDS` in src/index.ts\n" +
      "is the list the dispatcher matches against.\n",
  );
  process.exit(1);
}

main();
