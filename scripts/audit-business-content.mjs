/**
 * Business-content gate.
 *
 * This is a public MIT repository. Business model, pricing, competitor
 * analysis, vertical market research and channel strategy do not belong in it.
 * ADR-0019 already says so in its own Consequences section — "anything about
 * pricing, packaging or tiers ... do not belong in this repository in any
 * form" — and six such documents landed anyway.
 *
 * They landed because the only control was a `.gitignore` list that had to be
 * remembered and extended by hand every time a new strategy document was
 * written. It was not, and there was nothing to notice. This script is the
 * control that does not depend on anybody remembering.
 *
 * ## Why term-matching, and why an allowlist is mandatory
 *
 * There is no way to detect "commercial strategy" structurally, so this
 * matches vocabulary. That produces false positives with certainty, not by
 * accident: this project has a cost-aware model router, so `pricing`, `costUsd`
 * and `$/1M tokens` appear throughout legitimate engineering documents.
 *
 * The allowlist is therefore not an escape hatch bolted on afterwards — it is
 * half the design. Every entry carries a reason, and a reviewer reading the
 * allowlist should be able to tell a genuine exception from a silenced
 * finding.
 *
 * ## What this cannot do
 *
 * Catch business content that avoids the vocabulary. A strategy document
 * written in plain language about "who would pay for what" passes cleanly.
 * This raises the floor; it is not a guarantee, and it should not be described
 * as one.
 *
 * Usage:  node scripts/audit-business-content.mjs
 * Exit:   0 clean · 1 findings · 2 script/config error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/**
 * Terms that indicate commercial strategy rather than engineering.
 *
 * Deliberately NOT included: "cost", "price", "budget", "usd" — all load-bearing
 * in the cost-aware routing subsystem, and matching them would drown the signal.
 */
const TERMS = [
  { re: /\bgo-to-market\b/i, label: "go-to-market" },
  { re: /\bwillingness[- ]to[- ]pay\b/i, label: "willingness to pay" },
  { re: /\b(ARR|MRR)\b/, label: "revenue metric" },
  { re: /\bpaid tier\b/i, label: "paid tier" },
  { re: /\bfree tier\b/i, label: "free tier" },
  { re: /\bper[- ]seat\b/i, label: "per-seat pricing" },
  { re: /\bmonetis(e|ation)\b|\bmonetiz(e|ation)\b/i, label: "monetisation" },
  { re: /\brevenue (path|model|stream)\b/i, label: "revenue model" },
  { re: /\bpricing (model|strategy|tier|page)\b/i, label: "pricing strategy" },
  { re: /\bTAM\b/, label: "market sizing" },
  // Named first-party tiers. Added 2026-08-10: the terms above match the
  // vocabulary of a strategy document, but the leak that actually reached
  // users was a setup guide saying a token "is issued when you activate the
  // Pro plan" — an offer, in a numbered install step, that this gate read as
  // clean. Naming a tier IS packaging even when no price is quoted.
  { re: /\bPro[- ](?:tier|plan)\b/i, label: "named tier" },
  { re: /\bTeam[- ](?:tier|plan)\b/i, label: "named tier" },
  { re: /\bEnterprise[- ](?:tier|plan)\b/i, label: "named tier" },
  { re: /\breserved for Pro\b/i, label: "named tier" },
  { re: /\bactivate the Pro\b/i, label: "named tier" },
  { re: /\bpro-tier\.md\b/i, label: "out-of-repo pricing doc" },
  // Open-core framing. Added in the same pass and for a worse reason than the
  // patterns above it: those were written from the claims already found, so
  // the gate could only ever confirm the fix. It passed green while "ships
  // free in OSS core" survived 130 lines from an edit in the same file, and
  // while an accepted ADR said it too. Naming a feature's side of the
  // free/paid line is packaging in the same way naming a tier is.
  {
    re: /\bOSS[- ](?:core|vs)\b|\bfree OSS\b|\bOSS[- ]vs[- ]Pro\b/i,
    label: "open-core packaging",
  },
  // A price with a per-unit denominator ("$50/worker/mo"). The unit list is
  // deliberately narrow — it must not match provider token rates like
  // "$3 / 1M tokens", which the cost router documents legitimately.
  {
    re: /\$\s?\d[\d,.]*\s*(?:\/|per\s)\s*(?:worker|seat|user|mo\b|month)/i,
    label: "unit price",
  },
  { re: /\bchurn rate\b/i, label: "churn" },
  { re: /\bupsell\b/i, label: "upsell" },
  // Competitor funding intelligence — the specific shape that prompted this:
  // a named company with a raise amount.
  {
    re: /\b[A-Z][A-Za-z]+\s*\(\$\d+(\.\d+)?[MB]\b/,
    label: "competitor funding figure",
  },
];

/**
 * Text extensions scanned alongside markdown.
 *
 * Not an arbitrary list: it is the set a shipped string can reach a user
 * from — UI components, CLI output, YAML, JSON config, templates.
 */
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|txt|html|css|sh|toml)$/i;

/**
 * This file and its allowlist are the two places that MUST contain the
 * vocabulary — one defines the patterns, the other records the accepted
 * exceptions by term. Scanning them means every term matches itself, which
 * is not a finding; it is the gate reading its own source. Measured before
 * this exclusion existed: 20 of 20 hits across the whole non-markdown tree
 * were these two files.
 *
 * Excluded by exact path, never by a "does it look like a gate" heuristic:
 * a future script that genuinely leaks a price must not be able to exempt
 * itself by being named like an audit.
 */
const SELF = new Set([
  "scripts/audit-business-content.mjs",
  "scripts/audit-business-content-allowlist.json",
]);

/**
 * Files scanned: tracked markdown AND tracked source/config text.
 *
 * It was markdown only, on the reasoning that "code comments about cost
 * routing are noise". That reasoning covered the false positives and missed
 * the true ones — the leak this gate exists to stop is an OFFER, and an
 * offer reaches a user through a UI string or a CLI line at least as
 * readily as through a document. #1434/#1435 established the general form
 * in a sibling gate: a clipboard string in TSX promised a command that did
 * not exist, and the markdown-only checker could not see it. A `Pro plan`
 * upsell in a component is the same defect with worse consequences, since
 * ADR-0019 makes this a licensing boundary rather than a docs nit.
 *
 * Measured when the boundary was removed: 2,038 non-markdown files, 20
 * hits, all 20 of them this gate matching itself (see SELF). So this widens
 * the surface without importing a backlog — the allowlist stays as it is.
 */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".md") || TEXT_EXT.test(f))
    .filter((f) => !SELF.has(f));
}

function loadAllowlist() {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.join(root, "scripts/audit-business-content-allowlist.json"),
        "utf8",
      ),
    );
    if (!Array.isArray(parsed.allow))
      throw new Error("`allow` must be an array");
    return parsed.allow;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[business-content] allowlist unreadable: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  const allow = loadAllowlist();
  const isAllowed = (file, label) =>
    allow.some((a) => a.file === file && (a.term === label || a.term === "*"));

  const findings = [];
  const used = new Set();

  const files = trackedFiles();

  for (const file of files) {
    let content;
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // deleted between ls-files and read
    }
    content.split("\n").forEach((line, i) => {
      for (const { re, label } of TERMS) {
        if (!re.test(line)) continue;
        if (isAllowed(file, label)) {
          used.add(`${file}::${label}`);
          continue;
        }
        findings.push({
          file,
          line: i + 1,
          label,
          text: line.trim().slice(0, 110),
        });
      }
    });
  }

  const stale = allow.filter((a) => !used.has(`${a.file}::${a.term}`));

  console.log(
    `[business-content] scanned ${files.length} tracked text files ` +
      `(markdown + source/config) · ` +
      `${allow.length} allowlist entries (${stale.length} unused)`,
  );
  for (const s of stale) {
    console.log(
      `[business-content] NOTE unused allowlist entry — ${s.file} :: ${s.term} (${s.reason ?? "no reason recorded"})`,
    );
  }

  if (findings.length === 0) {
    console.log("[business-content] OK — no commercial content found.");
    process.exit(0);
  }

  console.error(
    `\n[business-content] FAIL — ${findings.length} possible commercial-strategy reference(s) in a public repository:\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.label}]`);
    console.error(`    ${f.text}`);
  }
  console.error(
    "\nThis repository is public and MIT. Business model, pricing, competitor\n" +
      "analysis and channel strategy belong outside it (ADR-0019).\n\n" +
      "Either move the document out of the repo and add it to .gitignore, or —\n" +
      "if this is a legitimate engineering use of the term — add it to\n" +
      "scripts/audit-business-content-allowlist.json with a reason.\n",
  );
  process.exit(1);
}

main();
