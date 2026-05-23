#!/usr/bin/env node
// scripts/create-github-label.mjs
// Run once to create the 'security-review-required' label in the GitHub repo.
// Usage: GITHUB_TOKEN=<token> node scripts/create-github-label.mjs [owner/repo]
//
// Requires: GITHUB_TOKEN env var
// The label is created with color #e11d48 (red) and the description below.

import { execSync } from "node:child_process";

const LABEL_NAME = "security-review-required";
const LABEL_COLOR = "e11d48";
const LABEL_DESCRIPTION =
  "PR touches security-sensitive files — shadow-run gate required";

function getRepoFromOrigin() {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf8",
    }).trim();
    // SSH: git@github.com:owner/repo.git
    // HTTPS: https://github.com/owner/repo.git
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (!match) throw new Error(`Cannot parse repo from remote URL: ${url}`);
    return match[1];
  } catch (err) {
    throw new Error(`Failed to determine repo from git remote: ${err.message}`);
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN env var is required.");
    process.exit(1);
  }

  const repo = process.argv[2] ?? getRepoFromOrigin();
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    console.error(
      `Error: Invalid repo format '${repo}'. Expected 'owner/repo'.`,
    );
    process.exit(1);
  }

  const url = `https://api.github.com/repos/${owner}/${repoName}/labels`;
  console.log(`Creating label '${LABEL_NAME}' in ${owner}/${repoName}…`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name: LABEL_NAME,
      color: LABEL_COLOR,
      description: LABEL_DESCRIPTION,
    }),
  });

  if (res.status === 422) {
    console.log("Label already exists, nothing to do.");
    return;
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: GitHub API returned ${res.status}: ${body}`);
    process.exit(1);
  }

  const label = await res.json();
  console.log(`Created label: '${label.name}' (color #${label.color})`);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
