/**
 * Permission rules that keep every bridge-spawned agent away from the files
 * where this runtime keeps its own secrets.
 *
 * A governed agent step is contained to Read/Glob/Grep/LS — read-only, but
 * read-ANYWHERE. Nothing in that containment named the runtime's own secret
 * stores, so a contained step could read the connector client secrets, the
 * encrypted connector tokens AND the key that decrypts them. Read-only was
 * never the same thing as harmless.
 *
 * Secrets are never legitimate agent input, so these rules apply on EVERY
 * dispatch path and in EVERY profile, compat included. They are added at the
 * spawn layer, after containment is resolved, so nothing a step declares —
 * its own `tools:` widening included — can remove them; and the CLI's own
 * precedence makes a deny beat an allow.
 *
 * What a path rule cannot do: stop a shell. A step granted `Bash` (compat, or
 * a governed `shell: true` widening) can still `cat` these files; Bash rules
 * are prefix matches on the command line and cannot express "any command that
 * touches this path". The governed default denies Bash for that reason.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { legacyPatchworkHome, patchworkHome } from "../patchworkHome.js";

/**
 * An absolute filesystem path in the CLI's permission-rule form: `//` +
 * a POSIX path. (`/x` in a rule is relative to the settings file; `//x` is
 * absolute.) Windows paths are matched in their POSIX form, `C:\a` → `/c/a`.
 */
export function toAbsoluteRulePath(p: string): string {
  let posix = p.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\/?(.*)$/.exec(posix);
  if (drive) posix = `/${(drive[1] ?? "").toLowerCase()}/${drive[2] ?? ""}`;
  posix = posix.replace(/\/+$/, "");
  return `/${posix.startsWith("/") ? posix : `/${posix}`}`;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // absent: nothing to resolve, the literal rule still applies
  }
}

function claudeConfigDir(): string {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? resolve(v) : join(homedir(), ".claude");
}

/** The secret-bearing paths (files, and directories as `<dir>/**`). */
export function secretStorePaths(): string[] {
  const out = new Set<string>();
  // Both roots: an operator who set PATCHWORK_HOME may still have the
  // pre-override directory on disk, secrets and all.
  // Each root also in its resolved form: the CLI may compare against the
  // real path, and `~/.patchwork` or a temp dir can sit behind a symlink.
  const roots = new Set<string>();
  for (const r of [patchworkHome(), legacyPatchworkHome()]) {
    roots.add(r);
    roots.add(realOrSelf(r));
  }
  for (const home of roots) {
    out.add(join(home, ".secrets.json")); // connector client secrets
    out.add(join(home, "tokens", "**")); // tokens, .master.key, oauth state
    out.add(join(home, "credentials.json")); // member password hashes
    out.add(join(home, ".env")); // dashboard session secret
  }
  const tokenDir = process.env.PATCHWORK_TOKEN_DIR?.trim();
  if (tokenDir) out.add(join(resolve(tokenDir), "**"));
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (process.platform === "win32" && localAppData) {
    out.add(join(localAppData, "PatchworkOS", "tokens", "**"));
  }
  for (const claude of new Set([
    claudeConfigDir(),
    realOrSelf(claudeConfigDir()),
  ])) {
    out.add(join(claude, ".credentials.json")); // the CLI's own sign-in
    out.add(join(claude, "ide", "**")); // bridge lock files carry auth tokens
  }
  return [...out];
}

/**
 * Files that DEFINE governance (audit M4). Not secrets — an agent may read
 * them — but an agent step allowed to write files (compat, or a governed
 * write widening) could otherwise switch governance off by editing them:
 * the kill switch (`config/flags.json`), the profile (`config.json`), the
 * roster, worker manifests and trust checkpoints, installed recipes (their
 * own `allowWrites` / `requireApproval`), and the evidence ledgers.
 */
export function governanceStatePaths(): string[] {
  const out = new Set<string>();
  for (const r of [patchworkHome(), legacyPatchworkHome()]) {
    for (const home of new Set([r, realOrSelf(r)])) {
      out.add(join(home, "config.json"));
      out.add(join(home, "config", "**"));
      out.add(join(home, "members.json"));
      out.add(join(home, "workers", "**"));
      out.add(join(home, "worker_trust", "**"));
      out.add(join(home, "recipes", "**"));
      out.add(join(home, "*.jsonl"));
      out.add(join(home, "*.jsonl.*"));
      out.add(join(home, "run-ledgers", "**"));
    }
  }
  return [...out];
}

/**
 * `Read(...)` and `Edit(...)` deny rules for every secret store, plus
 * `Edit(...)` only for governance state. Read rules
 * also govern Glob, Grep and LS; Edit rules govern every write built-in.
 * Read per call, never cached: PATCHWORK_HOME is changed at runtime by the
 * CLI and by tests.
 */
export function secretPathDenyRules(): string[] {
  const rules: string[] = [];
  for (const p of secretStorePaths()) {
    const rp = toAbsoluteRulePath(p);
    rules.push(`Read(${rp})`, `Edit(${rp})`);
  }
  for (const p of governanceStatePaths()) {
    rules.push(`Edit(${toAbsoluteRulePath(p)})`);
  }
  return rules;
}
