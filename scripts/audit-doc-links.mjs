/**
 * Relative-link gate for tracked markdown.
 *
 * Resolves every relative link in every tracked `.md` file and fails when the
 * target does not exist.
 *
 * ## Why this exists now
 *
 * Removing documents during this pass broke three links — in two ADRs and a
 * plan document — and the only reason they were caught was that I went looking
 * for them by hand. The docs-tree consolidation still ahead would move on the
 * order of 100 links at once. Doing that without a mechanical check is the
 * difference between "I believe nothing broke" and "CI says nothing broke",
 * and a broken link in a security or licensing document is the kind of rot
 * nobody reports.
 *
 * ## What counts as a link
 *
 * Markdown inline links `[text](target)` where the target is relative. Skipped:
 *
 *   - absolute URLs (`http://`, `https://`, `mailto:`) — reachability is not
 *     this script's job and a network check in CI is a flake generator
 *   - pure fragments (`#section`) — anchor validation needs a heading parser
 *     and would be a different, noisier gate
 *   - template placeholders (`{{...}}`, `<...>`) — recipe and prompt docs are
 *     full of them and they are not links
 *
 * A target's `#fragment` is stripped before resolution: the file must exist,
 * the anchor is not checked.
 *
 * Directory targets (`docs/adr/`) are satisfied by the directory existing.
 *
 * Usage:  node scripts/audit-doc-links.mjs
 * Exit:   0 clean · 1 broken links · 2 script error
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** `[text](target)` — target captured, nested parens not supported (rare). */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function trackedMarkdown() {
  return execFileSync("git", ["ls-files", "*.md"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

function isSkippable(target) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) || // any scheme: http, mailto, ftp…
    target.startsWith("#") ||
    target.startsWith("{{") ||
    target.startsWith("<") ||
    target.startsWith("//")
  );
}

/** Links that cannot resolve in-repo by design (templates rendered elsewhere). */
function loadAllowlist() {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.join(root, "scripts/audit-doc-links-allowlist.json"),
        "utf8",
      ),
    );
    if (!Array.isArray(parsed.allow))
      throw new Error("`allow` must be an array");
    return parsed.allow;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[doc-links] allowlist unreadable: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  const files = trackedMarkdown();
  const allow = loadAllowlist();
  const isAllowed = (file, target) =>
    allow.some((a) => a.file === file && a.target === target);
  const broken = [];
  let checked = 0;
  let outside = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const dir = path.dirname(path.join(root, file));

    content.split("\n").forEach((rawLine, i) => {
      // Strip inline code spans first. A regex like
      // `/^[a-zA-Z0-9](?:[a-zA-Z0-9-._]{0,38})$/` inside backticks is
      // indistinguishable from a markdown link to a naive matcher, and this
      // repo's docs are full of them.
      const line = rawLine.replace(/`[^`]*`/g, "");
      for (const m of line.matchAll(LINK_RE)) {
        const raw = m[1];
        if (!raw || isSkippable(raw)) continue;

        // Strip the fragment: the FILE must exist, the anchor is out of scope.
        const target = raw.split("#")[0];
        if (!target) continue; // was a pure fragment after all

        checked++;
        const resolved = target.startsWith("/")
          ? path.join(root, target.slice(1)) // repo-root-relative
          : path.resolve(dir, target);

        // A link that resolves OUTSIDE the repository cannot be validated
        // here — `docs/dogfood/recipe-inventory.md` points into a user's
        // runtime `~/.patchwork/recipes/`, which is correct and absent by
        // design. Counted so the skip is visible rather than silent.
        if (!resolved.startsWith(root + path.sep)) {
          outside++;
          continue;
        }

        if (!existsSync(resolved) && !isAllowed(file, raw)) {
          broken.push({ file, line: i + 1, target: raw });
        }
      }
    });
  }

  console.log(
    `[doc-links] ${files.length} tracked markdown files · ${checked} relative links checked` +
      (outside ? ` · ${outside} skipped (resolve outside the repo)` : ""),
  );

  if (broken.length === 0) {
    console.log("[doc-links] OK — no broken links.");
    process.exit(0);
  }

  console.error(`\n[doc-links] FAIL — ${broken.length} broken link(s):\n`);
  for (const b of broken) {
    console.error(`  ${b.file}:${b.line}  →  ${b.target}`);
  }
  console.error(
    "\nEither fix the path, or — if the document was deliberately removed —\n" +
      "replace the link with plain text so the statement survives without a\n" +
      "dead target.\n",
  );
  process.exit(1);
}

main();
