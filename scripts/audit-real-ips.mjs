/**
 * Public-IP-literal gate for tracked files.
 *
 * Fails when a tracked file contains a routable IPv4 address. Reserved,
 * private and documentation ranges are allowed, because those are what a
 * reader is supposed to see.
 *
 * ## Why this exists now
 *
 * `deploy/deploy-dashboard.sh` and `deploy/deploy-landing.sh` each carried a
 * hardcoded `VPS="root@<ip>"`. The hosting provider later reassigned that
 * address to an unrelated customer. The scripts did not notice, and could
 * not: an IP literal has no way of saying it changed hands.
 *
 * That mattered more than a stale value normally would, because
 * `deploy-dashboard.sh` passes `PATCHWORK_BRIDGE_TOKEN` and
 * `DASHBOARD_PASSWORD` to whatever host it names. The only thing standing
 * between "run the deploy script" and "send two secrets to a stranger" was
 * SSH's changed-host-key warning — a prompt a person can type `yes` past.
 *
 * Three more files carried the same address in documentation, and a fourth
 * carried a second, since-cancelled one. All five were found by accident,
 * four months after the address changed hands. That is the argument for a
 * gate rather than a convention: nothing was going to report this.
 *
 * ## What is allowed
 *
 *   - RFC 5737 documentation ranges (192.0.2.x, 198.51.100.x, 203.0.113.x)
 *     — the correct thing to write in an example
 *   - loopback (127.x), link-local (169.254.x), and RFC 1918 private ranges
 *     (10.x, 172.16-31.x, 192.168.x) — these describe a reader's own machine
 *   - 0.0.0.0 and 255.255.255.255 — bind-all and broadcast, not locations
 *   - multicast and reserved (224.x-255.x)
 *
 * Anything else is a real place on the internet and needs a reason.
 *
 * ## What this deliberately does NOT do
 *
 * No IPv6, and no hostnames. Both are real gaps. A hostname check would need
 * to distinguish `example.com` from a live host, which is a judgement call a
 * regex loses; the existing `audit-business-content.mjs` makes the same
 * trade-off and says so. Version numbers and semver strings are excluded by
 * requiring the match to look like an address, not a dotted quad in general.
 *
 * Usage:  node scripts/audit-real-ips.mjs
 * Exit:   0 clean · 1 public IP literal found · 2 script error
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Dotted quad with word boundaries. Octet range is validated separately. */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/**
 * Files not worth scanning.
 *
 * TESTS ARE EXCLUDED, deliberately and with a cost. The SSRF and rate-limit
 * suites assert things like `isPrivateHost("8.8.8.8") === false`, which is
 * only meaningful with a genuinely public address — 68 of the first run's
 * findings were exactly that, and every one was correct code. A gate whose
 * output is mostly false positives gets switched off, and then it protects
 * nothing.
 *
 * What this gives up: a real production address pasted into a test fixture
 * would not be caught. That is a narrower risk than the one being closed —
 * a test does not connect anywhere on deploy — but it is a real gap, not a
 * clean exclusion.
 */
const SKIP_FILE =
  /(^|\/)(package-lock\.json|\.gitattributes)$|\.(png|jpg|jpeg|gif|svg|ico|woff2?|pdf|vsix|tgz)$|(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

function isAllowedAddress(o) {
  const [a, b] = o;
  if (o.some((n) => n > 255)) return true; // not a valid address at all
  if (a === 0 || a === 127 || a >= 224) return true; // this-network, loopback, multicast/reserved
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 192 && b === 0) return true; // 192.0.2.0/24 docs + 192.0.0.0/24 IETF
  if (a === 198 && (b === 51 || b === 18 || b === 19)) return true; // docs + benchmarking
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 docs
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !SKIP_FILE.test(f));
}

/** Real addresses that must stay, each with a reason. */
function loadAllowlist() {
  try {
    const parsed = JSON.parse(
      readFileSync(
        path.join(root, "scripts/audit-real-ips-allowlist.json"),
        "utf8",
      ),
    );
    if (!Array.isArray(parsed.allow))
      throw new Error("`allow` must be an array");
    return parsed.allow;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[real-ips] allowlist unreadable: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  const files = trackedFiles();
  const allow = loadAllowlist();
  const used = new Set();
  const isAllowed = (file, ip) =>
    allow.some((a, i) => {
      const hit = a.file === file && a.ip === ip;
      if (hit) used.add(i);
      return hit;
    });

  const found = [];
  let scanned = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // binary or unreadable; not this gate's business
    }
    if (content.includes("\0")) continue;
    scanned++;

    content.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(IPV4_RE)) {
        const octets = m.slice(1, 5).map(Number);
        if (isAllowedAddress(octets)) continue;
        const ip = octets.join(".");
        if (isAllowed(file, ip)) continue;
        found.push({ file, line: i + 1, ip, text: line.trim().slice(0, 100) });
      }
    });
  }

  console.log(
    `[real-ips] scanned ${scanned} tracked text files · ${allow.length} allowlist entries`,
  );

  allow.forEach((a, i) => {
    if (!used.has(i))
      console.log(
        `[real-ips]   stale allowlist entry: ${a.file} / ${a.ip} — no longer present, delete it`,
      );
  });

  if (found.length === 0) {
    console.log("[real-ips] OK — no public IP literals.");
    process.exit(0);
  }

  console.error(`\n[real-ips] FAIL — ${found.length} public IP literal(s):\n`);
  for (const f of found) {
    console.error(`  ${f.file}:${f.line}  ${f.ip}\n    ${f.text}`);
  }
  console.error(
    "\nA real address in a tracked file goes stale silently, and a hosting\n" +
      "provider can reassign it to someone else without telling you. Use an\n" +
      "environment variable for anything a script connects to, and an\n" +
      "RFC 5737 documentation address (203.0.113.10) in examples.\n\n" +
      "If an address genuinely must stay, add it to\n" +
      "scripts/audit-real-ips-allowlist.json with a reason.\n",
  );
  process.exit(1);
}

main();
