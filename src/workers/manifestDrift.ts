/**
 * Worker-manifest drift detection (#1358).
 *
 * `templates/workers/` (shipped, versioned) and `~/.patchwork/workers/` (what
 * the gate actually reads) have no sync mechanism. Fixing a manifest in the
 * repo has no effect on a running bridge until someone hand-copies the file.
 *
 * The failure is silent and it is not hypothetical. In #1348 a worker's
 * manifest was missing `fs-write` from its `owns` list, so roughly a quarter
 * of its evidence classified as unowned and was dropped. The template fix
 * merged; the live gate kept reading the stale copy and kept dropping
 * evidence. Nothing errored — the gate read a valid-looking manifest and
 * simply attributed less than it should have.
 *
 * ## Why this REPORTS and does not reconcile
 *
 * The issue offers either. Reporting is the correct one, for two reasons that
 * both point the same way:
 *
 * 1. **Copying would clobber.** The live directory legitimately holds
 *    operator-authored workers that have no template, and an operator may
 *    have deliberately tuned a shipped one (an `autonomyCeiling` is exactly
 *    the kind of thing you lower locally and do not want restored). A sync
 *    that overwrites is a writer replacing a record it never checked it still
 *    owned — the same shape as the lock-file delete (#1359) and the config
 *    read-modify-write (#1361), both fixed the same week.
 *
 * 2. **The dangerous direction is silent, not loud.** A stale manifest
 *    under-attributes evidence, so the visible symptom is a worker that never
 *    earns trust — indistinguishable from a worker that simply has not run.
 *    Saying so out loud costs nothing; guessing which copy is authoritative
 *    can destroy an operator's policy.
 *
 * `localOnly` is therefore reported as INFORMATION and never as a warning: a
 * worker with no template is the normal case for anything the operator wrote,
 * and flagging it would train people to ignore the report.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ManifestDrift {
  /** Present in both, contents differ. The actionable case. */
  drifted: Array<{ name: string; templateHash: string; liveHash: string }>;
  /** Shipped with the product, absent from the live directory. */
  missingLocally: string[];
  /** Present locally with no template — operator-authored. Informational. */
  localOnly: string[];
}

const MANIFEST_RE = /\.worker\.ya?ml$/i;

function manifestsIn(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!MANIFEST_RE.test(name)) continue;
    try {
      // Hash CONTENT, not mtime. A copy changes mtime without changing
      // policy, and an edit can preserve it; only the bytes decide whether
      // the gate is reading something different from what shipped.
      const raw = readFileSync(path.join(dir, name), "utf-8");
      // Normalise line endings so a Windows checkout does not report every
      // manifest as drifted — that would be a signal that always fires.
      const normalised = raw.replace(/\r\n/g, "\n");
      out.set(name, createHash("sha256").update(normalised).digest("hex"));
    } catch {
      // Unreadable file: skip rather than throw. A drift REPORT that crashes
      // the bridge would be a worse failure than the drift it describes.
    }
  }
  return out;
}

export function detectWorkerManifestDrift(opts: {
  templatesDir: string;
  liveDir: string;
}): ManifestDrift {
  const templates = manifestsIn(opts.templatesDir);
  const live = manifestsIn(opts.liveDir);

  const drifted: ManifestDrift["drifted"] = [];
  const missingLocally: string[] = [];
  for (const [name, templateHash] of templates) {
    const liveHash = live.get(name);
    if (liveHash === undefined) {
      missingLocally.push(name);
    } else if (liveHash !== templateHash) {
      drifted.push({ name, templateHash, liveHash });
    }
  }

  const localOnly = [...live.keys()].filter((n) => !templates.has(n));

  drifted.sort((a, b) => a.name.localeCompare(b.name));
  missingLocally.sort();
  localOnly.sort();
  return { drifted, missingLocally, localOnly };
}

/**
 * Human-readable lines for the startup report, or `[]` when there is nothing
 * worth saying. Returning empty rather than "no drift" is deliberate: a
 * startup line that always prints is one people stop reading, and this one
 * needs to be noticed on the rare occasion it appears.
 */
export function formatWorkerManifestDrift(drift: ManifestDrift): string[] {
  const lines: string[] = [];
  if (drift.drifted.length > 0) {
    lines.push(
      `[workers] ${drift.drifted.length} manifest(s) differ from the shipped template — ` +
        "the gate reads the LOCAL copy, so a template fix has not taken effect:",
    );
    for (const d of drift.drifted) {
      lines.push(
        `  ${d.name}  template ${d.templateHash.slice(0, 12)} vs live ${d.liveHash.slice(0, 12)}`,
      );
    }
    lines.push(
      "  Review the differences and copy deliberately — this is NOT synced automatically, " +
        "because overwriting would discard local policy edits.",
    );
  }
  if (drift.missingLocally.length > 0) {
    lines.push(
      `[workers] ${drift.missingLocally.length} shipped manifest(s) are not installed: ${drift.missingLocally.join(", ")}`,
    );
  }
  return lines;
}
