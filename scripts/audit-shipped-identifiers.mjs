#!/usr/bin/env node
/**
 * Real-world identifiers must not ship.
 *
 * `templates/` and `examples/` are DISTRIBUTED — `package.json`'s `files`
 * includes `templates` wholesale, so anything here is packed into npm and lands
 * on every install. That makes them categorically worse than a doc: a real
 * identifier in `docs/` is published, but one here is published AND copied onto
 * other people's machines as working configuration.
 *
 * Found by scanning rather than by a gate, 2026-08-31: a real Slack channel id
 * appeared three times in a shipped example (labelled sales / marketing /
 * engineering, all the same id), and a real Slack workspace channel name sat in
 * a shipped template. Neither was caught by anything.
 *
 * ## Why this is not the private-identifier gate
 *
 * `audit-private-identifiers.mjs` matches an operator's DENYLIST, which by
 * design never enters the repository — so it cannot run in CI, and it only ever
 * sees a staged diff, a branch name and a commit message. It could not have
 * caught these: they were already committed, and CI has no denylist.
 *
 * This gate matches SHAPE instead, which needs no secret and therefore CAN run
 * in CI. The two are complements, not duplicates.
 *
 * ## Shape, deliberately, and only where shape is unambiguous
 *
 * It checks two things and refuses to guess at a third:
 *
 *   - Slack channel ids. `C` + 8-10 uppercase alphanumerics AND at least one
 *     digit. The digit requirement is load-bearing: without it the pattern
 *     matches ordinary uppercase English — `COMPLETED`, `CONSEQUENCE`,
 *     `CONVERSION` all appear legitimately in shipped recipes, in seven files.
 *     A gate that fires on those is a gate someone silences.
 *   - `/Users/<name>` absolute paths, which carry an operator's account name.
 *
 * It does NOT try to decide whether a domain or email is "real". That is not a
 * shape question — `acme.test` and a genuine company differ by knowledge, not
 * by form — and a gate that guesses would either miss the real ones or block
 * legitimate placeholders. That half stays with the denylist gate and with
 * reading the diff.
 *
 * Known and deliberate exception: a recipe whose FUNCTION is to filter mail
 * from a named service must name that service's sender address (the reading
 * capture example needs its two). That is the same carve-out CLAUDE.md already
 * makes for connector product names, and it is why this gate does not read
 * addresses at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["templates", "examples"];

/** Slack channel id shape. The digit requirement excludes English words. */
const SLACK_ID = /\bC(?=[A-Z0-9]{8,10}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b/g;
/** An operator's home directory, and so their account name. */
const USER_PATH = /\/Users\/[A-Za-z0-9._-]+/g;

/**
 * Obvious placeholders, allowed. Written as all-zeros runs so that a real id
 * cannot masquerade as one: a genuine Slack id with eight consecutive zeros is
 * not a thing anyone will hit by accident.
 */
const PLACEHOLDER = /^C0{7,}[A-Z0-9]*$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const findings = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    scanned += 1;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.match(SLACK_ID) ?? []) {
        if (PLACEHOLDER.test(m)) continue;
        findings.push({
          file,
          line: i + 1,
          kind: "slack channel id",
          value: m,
        });
      }
      for (const m of line.match(USER_PATH) ?? []) {
        findings.push({
          file,
          line: i + 1,
          kind: "operator home path",
          value: m,
        });
      }
    });
  }
}

if (scanned === 0) {
  // An empty scan must never read as a pass. Same rule the privacy verbs
  // follow: nothing observed and nothing to observe are different facts.
  console.error(
    "[shipped-ids] FAIL — scanned 0 files. templates/ and examples/ are missing or unreadable, so this gate verified NOTHING.",
  );
  process.exit(1);
}

if (findings.length === 0) {
  console.log(
    `[shipped-ids] OK — ${scanned} shipped file(s) carry no real-world identifier.`,
  );
  process.exit(0);
}

// The value IS printed here, unlike the denylist gate. These are not secrets
// drawn from a private list — they are strings already committed to a public
// repository, and an operator cannot fix "something somewhere" without knowing
// which string to replace.
console.error(
  `[shipped-ids] FAIL — ${findings.length} real-world identifier(s) in shipped artifacts:`,
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.kind}: ${f.value}`);
}
console.error(
  "\n  templates/ and examples/ are packed into npm and land on every install.",
);
console.error("  Replace with a placeholder (e.g. C00000000000, ~/ or $HOME).");
process.exit(1);
