/**
 * Secret reader — file-first, env-fallback.
 *
 * Long-form `_CLIENT_SECRET` / API-token credentials sit in
 * `~/.patchwork/.secrets.json` (a JSON object of `{ NAME: value }` pairs).
 * The helper reads from that file when present and falls back to
 * `process.env[name]` otherwise — so single-bridge users with an env-only
 * setup keep working unchanged, while multi-tenant deployments can mount a
 * read-only secrets file into the tenant volume to keep secrets out of the
 * container's env (visible via `/proc/<pid>/environ`, `printenv`,
 * `docker inspect`, etc.).
 *
 * Format: a single JSON object at `${HOME}/.patchwork/.secrets.json`.
 *   {
 *     "PATCHWORK_GITHUB_CLIENT_SECRET": "…",
 *     "GMAIL_CLIENT_SECRET": "…",
 *     "ANTHROPIC_API_KEY": "…"
 *   }
 *
 * Reload: every call `stat`s the file and re-reads it only when its
 * identity (inode, size, mtime, ctime) differs from the last good read. A
 * rotated secret is therefore picked up on the next call without a restart,
 * at the cost of one `stat` per call (microseconds, no read, no parse). A
 * time-based TTL was rejected: it would serve a rotated-away secret for the
 * whole window, and make "is the new value live yet?" depend on a clock.
 *
 * A read that fails mid-write (truncated file, half-written JSON, a non-object
 * value, EACCES) is NEVER cached: the last good contents keep being served
 * and the next call tries again. Only a confirmed-absent file (ENOENT) clears
 * the cache, because deleting the file is how an operator returns to env.
 *
 * Fail-soft: a missing file, EACCES, malformed JSON, or any read error all
 * route silently to the last good contents, or to env when there are none. We deliberately do NOT log on
 * these — single-bridge installs simply will not have a secrets file, and a
 * noisy warning every connector call would be operator-hostile.
 *
 * Precedence on collision (file present AND env set): the FILE wins. Reasoning:
 * the file path exists exactly to override env. Once a deployment opts into
 * the file by writing it, env values would be stale leftovers (or, worse, the
 * exact leak we are hiding from `/proc/.../environ`). The contract is "file
 * takes over when present", documented here so operators can reason about it.
 */

import { readFileSync, statSync } from "node:fs";
import { registerSecretValue } from "../governance/secretValues.js";
import { patchworkPath } from "../patchworkHome.js";

/** Absolute path the helper reads from. */
export function secretsFilePath(): string {
  return patchworkPath(".secrets.json");
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Last successfully parsed contents, and the identity of the file they came
 * from. `cachedKey === undefined` means nothing has been loaded yet;
 * `cachedKey === ABSENT` means the file was confirmed missing.
 */
const ABSENT = "absent";
let cachedKey: string | undefined;
let cached: Record<string, string> | null = null;

function fileKey(st: {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function load(): Record<string, string> | null {
  const file = secretsFilePath();
  let key: string;
  try {
    key = fileKey(statSync(file));
  } catch (err) {
    if (isMissing(err)) {
      cachedKey = ABSENT;
      cached = null;
    }
    // Any other stat error: keep serving the last good value, retry next call.
    return cached;
  }
  if (key === cachedKey) return cached;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Not the documented shape — treat like a partial write: do not cache.
      return cached;
    }
    // Coerce to Record<string, string>; drop non-string values defensively.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    cached = out;
    cachedKey = key;
    return cached;
  } catch (err) {
    if (isMissing(err)) {
      cachedKey = ABSENT;
      cached = null;
    }
    // SyntaxError (half-written) / EACCES: keep the last good value and leave
    // `cachedKey` alone so the next call reads again.
    return cached;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a named secret. Tries the secrets file first; falls back to
 * `process.env[name]`; returns `""` when neither is set.
 *
 * Returning empty string (not `undefined`) matches the existing `?? ""`
 * pattern at every connector call site — keeps the contract identical so the
 * substitution is a drop-in.
 */
export function readSecret(name: string): string {
  const fromFile = load();
  if (fromFile && Object.hasOwn(fromFile, name)) {
    const v = fromFile[name];
    if (typeof v === "string" && v !== "") {
      registerSecretValue(v, "secrets-file");
      return v;
    }
    // Empty string in the file → still try env (treat the file value as unset).
  }
  const fromEnv = process.env[name] ?? "";
  // Anything a connector asks for by name IS a credential — register the
  // value (never the name) so it is redacted wherever it reappears.
  if (fromEnv) registerSecretValue(fromEnv, "env");
  return fromEnv;
}

/**
 * Test hook — forgets the cached file read (including the last good value)
 * so a test starts from a clean process state. Never called in production.
 */
export function _resetSecretsCacheForTests(): void {
  cachedKey = undefined;
  cached = null;
}
