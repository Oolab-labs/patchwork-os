/**
 * Production-dependency CVE gate, across every workspace in the repository.
 *
 * Runs `npm audit --omit=dev` against each tracked `package-lock.json` and
 * fails on any advisory of `high` severity or above.
 *
 * ## Why this exists now
 *
 * The gate this replaces was a single `npm audit --omit=dev --audit-level=high`
 * step in `ci.yml`, run from the repository root. The root is one of FOUR
 * tracked lockfiles. `dashboard/`, `services/push-relay/` and
 * `vscode-extension/` were never audited by CI at all, and each one ships:
 * the dashboard is deployed, the relay is deployed, the extension is packaged
 * into a `.vsix` a user installs.
 *
 * That gap was not theoretical. GHSA-2v37-7h3g-55p8 (`nanoid`, high, reached
 * through `next` → `postcss`) sat open in the dashboard's PRODUCTION tree
 * while the root-only gate reported green. Worse, the step's own comment cited
 * "vitest → vite → postcss → nanoid" as its example of a dev-only advisory
 * that was deliberately excluded — so the comment actively argued that a
 * nanoid finding was out of scope, while a different nanoid, on a production
 * path, in a workspace nobody was looking at, was in scope and unreported.
 *
 * ## Why discovery rather than a list of four paths
 *
 * A hardcoded list is a rule that depends on somebody remembering to extend it
 * when a workspace is added — which is the failure mode that produced the gap
 * in the first place. Lockfiles are discovered from `git ls-files`, so a new
 * workspace is covered the day its lockfile lands.
 *
 * ## Scope of the check — deliberately unchanged from the gate it replaces
 *
 *   - PRODUCTION dependencies only (`--omit=dev`). Dev-tooling advisories are
 *     real but are not in any shipped artifact, and gating on them makes this
 *     job red on somebody else's release schedule.
 *   - `high` and `critical` only. Moderate and low are reported for visibility
 *     and do not fail the build.
 *
 * This script widens the gate's COVERAGE. It does not lower its threshold.
 *
 * Usage:  node scripts/audit-production-cves.mjs
 * Exit:   0 clean · 1 unallowlisted high/critical advisory · 2 script error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Severities that fail the build. Everything else is reported only. */
const FAILING = new Set(["high", "critical"]);

function trackedLockfiles() {
  return execFileSync("git", ["ls-files", "*package-lock.json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .map((f) => path.dirname(f)) // "dashboard/package-lock.json" → "dashboard"
    .sort();
}

/** Advisories accepted for now. Every entry needs a reason. */
function loadAllowlist() {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.join(root, "scripts/audit-production-cves-allowlist.json"),
        "utf8",
      ),
    );
    if (!Array.isArray(parsed.allow))
      throw new Error("`allow` must be an array");
    return parsed.allow;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[prod-cves] allowlist unreadable: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Run `npm audit --omit=dev --json` in one workspace.
 *
 * npm exits non-zero whenever it finds anything at or above `--audit-level`,
 * so the exit code cannot distinguish "vulnerabilities found" from "npm could
 * not run". The report is parsed from stdout instead, and an unparseable
 * stdout is what counts as a script error — otherwise a network failure would
 * read as a clean audit, which is the one way a supply-chain gate must never
 * fail.
 */
/** One `npm audit` attempt. Returns stdout, or null when there is none. */
function auditOnce(dir) {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: path.join(root, dir),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Non-zero exit is EXPECTED when advisories exist; the report is still on
    // stdout. Only a missing/empty stdout is a real failure.
    return err.stdout || null;
  }
}

/** True when stdout is a real npm audit report rather than an error envelope. */
function isAuditReport(stdout) {
  if (!stdout) return false;
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    return false;
  }
  return (
    r !== null &&
    typeof r === "object" &&
    r.auditReportVersion !== undefined &&
    typeof r.metadata?.vulnerabilities === "object"
  );
}

function auditWorkspace(dir) {
  // RETRY before failing closed.
  //
  // Failing closed on a registry hiccup is correct for a security gate, and it
  // would also make this a new source of CI flakes in a repo that already has
  // one (#1386). `npm audit` is a read-only, idempotent query, so retrying is
  // free of side effects — the only cost is time on a genuinely broken
  // registry, which is a case that SHOULD be slow and loud.
  //
  // Observed while building this: a transient failure on one attempt, clean on
  // the next, seconds apart.
  const DELAYS_MS = [0, 2000, 6000];
  let stdout = null;
  for (let attempt = 0; attempt < DELAYS_MS.length; attempt++) {
    if (DELAYS_MS[attempt] > 0) {
      // Synchronous sleep: this script is a sequential CLI gate, and pulling
      // in async plumbing for a backoff would be the larger change.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        DELAYS_MS[attempt],
      );
    }
    stdout = auditOnce(dir);
    if (isAuditReport(stdout)) break;
    if (attempt < DELAYS_MS.length - 1) {
      console.warn(
        `[prod-cves] ${dir}: attempt ${attempt + 1} did not return an audit report — retrying`,
      );
    }
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    console.error(`[prod-cves] ${dir}: npm audit output was not JSON`);
    process.exit(2);
  }

  // The JSON parsing above is NOT sufficient, and assuming it was made this a
  // security gate that failed open.
  //
  // On any registry failure npm emits perfectly well-formed JSON:
  //
  //     { "message": "request to …/security/advisories/bulk failed, reason:
  //                   connect ECONNREFUSED …",
  //       "error": { "summary": "", "detail": "" } }
  //
  // `JSON.parse` succeeds, `report.vulnerabilities ?? {}` yields `{}`, the
  // findings loop runs zero times, and the gate prints
  //
  //     [prod-cves] 4 workspace(s) audited (production deps only): …
  //     [prod-cves] OK — no high or critical production advisories.
  //
  // — byte-identical to a clean run, exit 0. Measured against a dead registry,
  // not inferred. Any outage, DNS failure or rate-limit therefore reported
  // "no advisories" for the whole repo, and the header's claim that
  // unparseable stdout is the guard was simply false: the failure output
  // parses fine.
  //
  // So assert the report IS an audit report. npm's v2 schema always carries
  // `auditReportVersion` and `metadata.vulnerabilities`; the error envelope
  // carries neither. Exit 2 (script/config error) rather than 1, because
  // "we could not audit" is a different fact from "we audited and found
  // nothing", and the two must never print the same thing.
  const looksLikeAuditReport =
    report !== null &&
    typeof report === "object" &&
    report.auditReportVersion !== undefined &&
    typeof report.metadata?.vulnerabilities === "object";

  if (!looksLikeAuditReport) {
    const why =
      typeof report?.message === "string"
        ? report.message
        : "response did not contain auditReportVersion / metadata.vulnerabilities";
    console.error(
      `\n[prod-cves] ${dir}: npm audit did NOT return an audit report — nothing was checked.\n\n` +
        `  ${why}\n\n` +
        `  This is a hard failure on purpose. npm returns well-formed JSON when the\n` +
        `  registry is unreachable, so treating "parsed OK" as "audited OK" made this\n` +
        `  gate report a clean supply chain on every outage.\n`,
    );
    process.exit(2);
  }

  const found = [];
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    // `via` mixes advisory objects with plain strings (transitive parents);
    // only the objects carry an identifier.
    const advisories = (v.via ?? []).filter(
      (entry) => typeof entry === "object" && entry !== null,
    );
    const ids = advisories
      .map((a) => ghsaFrom(a.url) ?? String(a.source ?? ""))
      .filter(Boolean);
    found.push({
      workspace: dir,
      name,
      severity: v.severity,
      ids: [...new Set(ids)],
      title: advisories[0]?.title ?? "",
    });
  }
  return found;
}

/** "https://github.com/advisories/GHSA-xxxx-…" → "GHSA-xxxx-…" */
function ghsaFrom(url) {
  const m = /\/advisories\/(GHSA-[\w-]+)/.exec(url ?? "");
  return m ? m[1] : null;
}

function main() {
  const workspaces = trackedLockfiles();
  if (workspaces.length === 0) {
    console.error("[prod-cves] no tracked package-lock.json found");
    process.exit(2);
  }

  const allow = loadAllowlist();
  const used = new Set();
  const isAllowed = (finding) =>
    allow.some((a, i) => {
      const hit =
        a.workspace === finding.workspace && finding.ids.includes(a.advisory);
      if (hit) used.add(i);
      return hit;
    });

  const failing = [];
  const reported = [];

  for (const dir of workspaces) {
    for (const finding of auditWorkspace(dir)) {
      if (!FAILING.has(finding.severity)) {
        reported.push(finding);
        continue;
      }
      if (isAllowed(finding)) {
        reported.push({ ...finding, allowlisted: true });
        continue;
      }
      failing.push(finding);
    }
  }

  console.log(
    `[prod-cves] ${workspaces.length} workspace(s) audited (production deps only): ` +
      workspaces.map((w) => (w === "." ? "<root>" : w)).join(", "),
  );

  for (const r of reported) {
    const tag = r.allowlisted ? "allowlisted" : "below threshold";
    console.log(
      `[prod-cves]   ${r.workspace}: ${r.name} (${r.severity}, ${tag})`,
    );
  }

  // Unused entries are reported, not fatal, so they can be deleted — an
  // allowlist that outlives its advisory is how a gate quietly stops gating.
  allow.forEach((a, i) => {
    if (!used.has(i))
      console.log(
        `[prod-cves]   stale allowlist entry: ${a.workspace} / ${a.advisory} — no longer reported, delete it`,
      );
  });

  if (failing.length === 0) {
    console.log("[prod-cves] OK — no high or critical production advisories.");
    process.exit(0);
  }

  console.error(
    `\n[prod-cves] FAIL — ${failing.length} high/critical production advisory(ies):\n`,
  );
  for (const f of failing) {
    console.error(
      `  ${f.workspace === "." ? "<root>" : f.workspace}: ${f.name} — ${f.severity}` +
        `${f.ids.length ? ` (${f.ids.join(", ")})` : ""}` +
        `${f.title ? `\n    ${f.title}` : ""}`,
    );
  }
  console.error(
    "\nFix with `npm audit fix` in the named workspace. If the advisory cannot\n" +
      "be fixed yet, add it to scripts/audit-production-cves-allowlist.json\n" +
      "with a reason — an unexplained exception is indistinguishable from an\n" +
      "oversight the next time somebody reads this.\n",
  );
  process.exit(1);
}

main();
