#!/usr/bin/env node
/**
 * Snapshot the bot-vs-human clone hypothesis using GitHub's free traffic APIs.
 *
 * Compares total clones to unique cloners — a low unique/total ratio
 * (typically <0.15) suggests bot/CI/mirror traffic dominates. Cross-references
 * with the page-view referrer list to see where actual humans came from.
 *
 * Outputs GitHub Actions job-summary markdown when GITHUB_STEP_SUMMARY is set,
 * otherwise prints to stdout. Read-only — never writes back to the repo.
 *
 * Env:
 *   GH_REPO   — owner/repo (default Oolab-labs/patchwork-os)
 *   GH_TOKEN  — PAT with repo:read; required (the traffic API gates on push perms)
 */
import { appendFile } from "node:fs/promises";

const REPO = process.env.GH_REPO ?? "Oolab-labs/patchwork-os";
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error(
    "GH_TOKEN required (needs push perms — that's what gates /traffic/)",
  );
  process.exit(2);
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "patchwork-analyze-clones",
    },
  });
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const [clones, views, referrers] = await Promise.all([
  gh(`/repos/${REPO}/traffic/clones`),
  gh(`/repos/${REPO}/traffic/views`),
  gh(`/repos/${REPO}/traffic/popular/referrers`),
]);

const totalClones = clones.count;
const uniqueCloners = clones.uniques;
const totalViews = views.count;
const uniqueViewers = views.uniques;
const ratio = totalClones > 0 ? uniqueCloners / totalClones : 0;

const verdict =
  totalClones === 0
    ? "no data"
    : ratio < 0.15
      ? "**likely bot-dominated** (low unique/total ratio)"
      : ratio < 0.4
        ? "mixed bots + humans"
        : "**likely human-dominated**";

const lines = [];
lines.push(`# Clone-traffic snapshot — ${REPO}`);
lines.push("");
lines.push(
  `_Generated ${new Date().toISOString()}. GitHub /traffic API returns the last 14 days._`,
);
lines.push("");
lines.push("| Metric | Value |");
lines.push("|---|---|");
lines.push(`| Total clones (14d) | ${totalClones} |`);
lines.push(`| Unique cloners (14d) | ${uniqueCloners} |`);
lines.push(`| unique / total | ${(ratio * 100).toFixed(1)}% — ${verdict} |`);
lines.push(`| Total page views (14d) | ${totalViews} |`);
lines.push(`| Unique viewers (14d) | ${uniqueViewers} |`);
lines.push("");
lines.push("## Top page-view referrers");
lines.push("");
if (referrers.length === 0) {
  lines.push("_no referrers in window_");
} else {
  lines.push("| Referrer | Views | Unique |");
  lines.push("|---|---|---|");
  for (const r of referrers) {
    lines.push(`| ${r.referrer} | ${r.count} | ${r.uniques} |`);
  }
}
lines.push("");
lines.push("## How to read this");
lines.push("");
lines.push(
  "- **Unique cloners** counts distinct IPs cloning over 14d. Repeated CI / mirror crawlers from a tight IP range count as 1.",
);
lines.push(
  "- A low **unique / total** ratio (<15%) usually means a handful of automated cloners are inflating the headline count.",
);
lines.push(
  "- **Referrers** are for page views only — GitHub doesn't expose referrer on raw `git clone`. A low referrer-to-clone ratio is another bot signal.",
);
lines.push("");

const out = lines.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, out);
}
process.stdout.write(out);
