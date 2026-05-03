#!/usr/bin/env node
import { execSync } from "node:child_process";
/**
 * dogfood-personal-signals.mjs
 *
 * Runs computePersonalSignals over a real persisted activityLog and
 * reports what would have fired on each recent approval_decision row,
 * had the signals layer been live at the time. The point is to see
 * whether the catalog produces useful, non-noisy output on the
 * developer's own history.
 *
 * Usage:
 *   node scripts/dogfood-personal-signals.mjs [path-to-activity.jsonl]
 *
 * Defaults to the most-recent ~/.claude/ide/activity-*.jsonl.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ActivityLog } from "../dist/activityLog.js";
import { computePersonalSignals } from "../dist/approvalSignals.js";

function pickPath() {
  if (process.argv[2]) return process.argv[2];
  const dir = path.join(homedir(), ".claude/ide");
  const out = execSync(
    `ls -t "${dir}"/activity-*.jsonl 2>/dev/null | head -1`,
    {
      encoding: "utf8",
    },
  ).trim();
  if (!out) {
    console.error("No activity-*.jsonl files found in ~/.claude/ide/");
    process.exit(1);
  }
  return out;
}

const persistPath = pickPath();
const stat = statSync(persistPath);
console.log(`Loading ${persistPath} (${(stat.size / 1024).toFixed(0)} KB)`);

// ActivityLog.setPersistPath loads the file. Use a generous cap so we
// keep enough history to make heuristics like h7 (tier baseline ≥ 5)
// and h11 (param novelty baseline ≥ 5) actually fire.
const log = new ActivityLog(5000);
log.setPersistPath(persistPath);

// Find recent approval_decision rows to replay.
const lifecycle = log
  .queryTimeline({ last: 200 })
  .filter((e) => e.kind === "lifecycle" && e.event === "approval_decision");

console.log(
  `Found ${lifecycle.length} approval_decision rows in the most recent timeline window.\n`,
);

if (lifecycle.length === 0) {
  // Fall back to scanning the raw file for ALL approval_decision rows.
  const raw = readFileSync(persistPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  let approvalCount = 0;
  let toolCount = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.kind === "lifecycle" && obj.event === "approval_decision")
        approvalCount++;
      if (obj.kind === "tool") toolCount++;
    } catch {
      /* skip */
    }
  }
  console.log(
    `Raw scan: ${approvalCount} approval_decision rows, ${toolCount} tool rows in this file.`,
  );
  console.log(
    "Bridge wasn't recording approval_decision events when this log was written — h1, h2, h7, h9 baselines will be empty.",
  );
  console.log(
    "Heuristics that work over tool entries (h3, h5, h8, h10, h12) can still fire — replaying against the most-recent tool calls instead.\n",
  );

  // Replay the last 25 tool calls as if each were an incoming approval.
  const tools = log
    .queryTimeline({ last: 200 })
    .filter((e) => e.kind === "tool")
    .slice(-25);

  let fired = 0;
  const kindCounts = new Map();
  for (const t of tools) {
    const signals = computePersonalSignals({
      toolName: t.tool,
      activityLog: log,
      currentTier: "low",
      currentWorkspace: process.cwd(),
      enableTimeOfDayAnomaly: true,
      currentParams: {},
    });
    if (signals.length > 0) {
      fired++;
      for (const s of signals) {
        kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
      }
      console.log(`[${t.timestamp}] ${t.tool}`);
      for (const s of signals) {
        console.log(
          `  • ${s.severity.padEnd(6)} ${s.kind.padEnd(22)} ${s.label}`,
        );
      }
    }
  }
  console.log(
    `\nSummary: ${fired}/${tools.length} replayed tool calls produced ≥ 1 signal.`,
  );
  console.log("Kinds fired:");
  for (const [k, n] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  process.exit(0);
}

// Replay each approval_decision as if the call were just-arrived.
let fired = 0;
const kindCounts = new Map();
for (const e of lifecycle.slice(-25)) {
  const meta = e.metadata ?? {};
  const toolName = meta.toolName;
  if (!toolName) continue;
  const signals = computePersonalSignals({
    toolName,
    activityLog: log,
    currentTier: meta.tier,
    currentWorkspace: meta.workspace,
    enableTimeOfDayAnomaly: true,
    currentParams: meta.params ?? {},
  });
  if (signals.length > 0) {
    fired++;
    for (const s of signals) {
      kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
    }
    console.log(
      `[${e.timestamp}] ${toolName} (${meta.decision ?? "?"}, tier ${meta.tier ?? "?"})`,
    );
    for (const s of signals) {
      console.log(
        `  • ${s.severity.padEnd(6)} ${s.kind.padEnd(22)} ${s.label}`,
      );
    }
  }
}
console.log(
  `\nSummary: ${fired}/${Math.min(lifecycle.length, 25)} replayed approvals produced ≥ 1 signal.`,
);
console.log("Kinds fired:");
for (const [k, n] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${n}`);
}
