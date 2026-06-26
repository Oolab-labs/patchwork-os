import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecipeRunLog } from "../runLog.js";
import type { DecisionRecord, RunRecord } from "./shadowObserver.js";
import { buildShadowReport, formatShadowReport } from "./shadowReport.js";
import { loadWorkersFromDir } from "./workerLoader.js";

/**
 * I/O entry for the shadow logger: read the REAL logs the bridge already
 * writes — `~/.patchwork/runs.jsonl` (RecipeRunLog → the dial's evidence) and
 * `~/.claude/ide/activity-*.jsonl` (the live gate's approval decisions) — and
 * produce the trust-dial + ramp-vs-gate report. Fully read-only; touches
 * nothing. Empty logs are honest, not an error (new workers have no activity).
 */

export interface RunWorkerShadowOpts {
  /** Where worker manifests live (default ~/.patchwork/workers). */
  workersDir?: string;
  /** ~/.patchwork (runs.jsonl) override (tests). */
  patchworkDir?: string;
  /** ~/.claude/ide (activity-*.jsonl) override (tests). */
  ideDir?: string;
}

function readRuns(patchworkDir: string): RunRecord[] {
  try {
    const log = new RecipeRunLog({ dir: patchworkDir });
    return log.query({}).map((r) => ({
      recipeName: r.recipeName,
      at: r.doneAt ?? r.startedAt ?? r.createdAt,
      steps: (r.stepResults ?? []).map((s) => ({
        tool: s.tool,
        status: s.status,
      })),
    }));
  } catch {
    return [];
  }
}

function readDecisions(ideDir: string): DecisionRecord[] {
  let files: string[];
  try {
    files = readdirSync(ideDir).filter((f) => /^activity-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(path.join(ideDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      // cheap pre-filter before the JSON.parse; an empty line never matches
      if (!t.includes("approval_decision")) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (obj.event !== "approval_decision") continue;
      const md = (obj.metadata ?? {}) as Record<string, unknown>;
      const decision =
        md.decision === "allow"
          ? "allow"
          : md.decision === "deny"
            ? "deny"
            : null;
      if (typeof md.toolName !== "string" || !decision) continue;
      out.push({
        toolName: md.toolName,
        decision,
        at:
          typeof obj.timestamp === "string"
            ? Date.parse(obj.timestamp) || 0
            : 0,
      });
    }
  }
  return out;
}

export function runWorkerShadowReport(opts: RunWorkerShadowOpts = {}): string {
  const home = os.homedir();
  const patchworkDir = opts.patchworkDir ?? path.join(home, ".patchwork");
  const ideDir = opts.ideDir ?? path.join(home, ".claude", "ide");
  const workersDir = opts.workersDir ?? path.join(patchworkDir, "workers");

  const workers = loadWorkersFromDir(workersDir);
  if (workers.length === 0) {
    return `No worker manifests found in ${workersDir}.\nAdd *.worker.yaml there (e.g. copy templates/workers/) and re-run.\n`;
  }

  const runs = readRuns(patchworkDir);
  const decisions = readDecisions(ideDir);
  const reports = buildShadowReport(workers, runs, decisions);
  return `${formatShadowReport(reports)}\n(scanned ${runs.length} recipe runs, ${decisions.length} gate decisions · read-only)\n`;
}
