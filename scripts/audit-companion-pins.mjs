#!/usr/bin/env node
// scripts/audit-companion-pins.mjs
// Checks companion package version pins against npm latest.
// Exits 0 if all pins are within 5 minor/patch versions of latest.
// Exits 1 if any pin is more than 5 versions behind (or any check fails).
// Usage: node scripts/audit-companion-pins.mjs [--strict] [--json]

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const strict = process.argv.includes("--strict");
const jsonMode = process.argv.includes("--json");

// ── Parse registry.ts as text ────────────────────────────────────────────────

const registryPath = resolve(ROOT, "src/companions/registry.ts");
const registryText = readFileSync(registryPath, "utf8");

// Match patterns like: "@modelcontextprotocol/server-memory@2026.1.26"
// or "superpowers-mcp@4.3.2" inside args arrays.
// Captures the full "pkg@version" string from quoted array elements.
const PIN_RE = /"((?:@[^/]+\/)?[^@"]+)@(\d[^"]+)"/g;

const pins = new Map(); // pkg → pinnedVersion
let match;
while ((match = PIN_RE.exec(registryText)) !== null) {
  const [, pkg, version] = match;
  // Skip non-package strings (e.g. flags like "--transport")
  if (!pkg.includes("/") && !pkg.match(/^[a-z@]/i)) continue;
  // Only keep if it looks like a real package name (contains letters, optional scope)
  if (pkg.startsWith("-")) continue;
  pins.set(pkg, version);
}

if (pins.size === 0) {
  if (!jsonMode) console.error("No pinned packages found in registry.ts");
  process.exit(1);
}

// ── npm registry fetch ────────────────────────────────────────────────────────

async function fetchLatest(pkg) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace(/%40/g, "@")}/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pkg}`);
  const data = await res.json();
  return data.version;
}

// ── Version comparison ────────────────────────────────────────────────────────
// Returns number of numeric segments that differ (positionally), or -1 if latest < pinned.
// Simple: split by ".", compare segment by segment.

/**
 * Compare two semver strings, stopping at the FIRST differing segment.
 *
 * The previous version kept scanning after a difference, so a later segment
 * could reverse the verdict. `1.0.1` vs `1.7.0`: minor says behind, then patch
 * (1 vs 0) said "ahead" and returned -1. Two REAL pins were reported as
 * `pinned > latest — likely prerelease` while being 7 minors and 2 MAJORS
 * behind respectively.
 *
 * Returns `{ behind, level, by }`. `level` is the segment that actually
 * decides — major/minor/patch — because "6 segments behind" was never a
 * meaningful quantity, and it is what made the old threshold unreachable
 * (see `significantlyBehind` below).
 */
function compareVersions(pinned, latest) {
  const p = pinned.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const l = latest.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const LEVELS = ["major", "minor", "patch"];
  for (let i = 0; i < 3; i++) {
    const pv = p[i] ?? 0;
    const lv = l[i] ?? 0;
    if (pv === lv) continue;
    return lv > pv
      ? { behind: true, level: LEVELS[i], by: lv - pv }
      : { behind: false, level: LEVELS[i], by: pv - lv, ahead: true };
  }
  return { behind: false, level: null, by: 0 };
}

/**
 * Legacy shape kept for the JSON output: -1 = ahead, 0 = equal, else a
 * positive distance. Now derived from the real comparison.
 */
function versionDistance(pinned, latest) {
  if (pinned === latest) return 0;
  const c = compareVersions(pinned, latest);
  if (!c.behind) return -1;
  return c.by;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const results = [];
let anyFailed = false;

await Promise.all(
  [...pins.entries()].map(async ([pkg, pinned]) => {
    let latest = null;
    let error = null;
    try {
      latest = await fetchLatest(pkg);
    } catch (e) {
      error = e.message;
    }

    const upToDate = error ? null : pinned === latest;
    const distance = error ? null : versionDistance(pinned, latest);
    const cmp = error ? null : compareVersions(pinned, latest);
    // A pin is "significantly behind" when it is a MAJOR version back, or
    // more than 5 minors back.
    //
    // The previous rule was `distance > 5`, where `distance` counted segments
    // that differed. Semver has three segments, so it was bounded by 3 and the
    // condition was UNREACHABLE — in default mode this gate could only ever
    // fail on a fetch error, never on a stale pin, which is the one thing it
    // exists to detect. Combined with the ordering bug above, it had no way to
    // report the two real pins sitting 7 minors and 2 majors behind.
    const significantlyBehind =
      cmp !== null &&
      cmp.behind === true &&
      (cmp.level === "major" || (cmp.level === "minor" && cmp.by > 5));

    results.push({ package: pkg, pinned, latest, upToDate, distance, error });

    if (error || significantlyBehind) anyFailed = true;
  }),
);

// Sort by package name for stable output
results.sort((a, b) => a.package.localeCompare(b.package));

if (jsonMode) {
  const output = results.map(
    ({ package: pkg, pinned, latest, upToDate, error }) => ({
      package: pkg,
      pinned,
      latest: latest ?? null,
      upToDate: upToDate ?? false,
      ...(error ? { error } : {}),
    }),
  );
  console.log(JSON.stringify(output, null, 2));
} else {
  let hasWarning = false;
  for (const {
    package: pkg,
    pinned,
    latest,
    upToDate,
    distance,
    error,
  } of results) {
    if (error) {
      console.warn(`WARN  ${pkg}@${pinned} — fetch failed: ${error}`);
      hasWarning = true;
    } else if (upToDate) {
      console.log(`OK    ${pkg}@${pinned}`);
    } else if (distance === -1) {
      console.log(
        `OK    ${pkg}@${pinned} (pinned ${pinned} > latest ${latest} — likely prerelease)`,
      );
    } else {
      // Same rule as `significantlyBehind`, not a second one. When the tag and
      // the exit code disagreed, a pin two MAJORS back printed as `WARN` — the
      // reader's summary and the build's verdict telling different stories.
      const c = compareVersions(pinned, latest);
      const stale =
        c.behind && (c.level === "major" || (c.level === "minor" && c.by > 5));
      const tag = stale ? "STALE" : "WARN ";
      console.warn(
        `${tag} ${pkg}@${pinned} → latest ${latest} (${c.by} ${c.level}(s) behind)`,
      );
      hasWarning = true;
    }
  }
  if (!hasWarning) {
    console.log("All companion pins are up to date.");
  }
}

// --strict: exit 1 if any pin is behind latest
// default: exit 0 (informational only), exit 1 only if significantly behind (>5 segments)
if (strict) {
  const anyBehind = results.some((r) => r.error || r.latest !== r.pinned);
  process.exit(anyBehind ? 1 : 0);
} else {
  process.exit(anyFailed ? 1 : 0);
}
