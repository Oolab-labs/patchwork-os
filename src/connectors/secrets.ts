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
 * The file is read once (lazily) and cached in-memory. A successful parse
 * locks the cache for the lifetime of the process — `readFileSync` on every
 * OAuth call would be a perf footgun. Tests that need to swap the file MUST
 * call `_resetSecretsCacheForTests()`.
 *
 * Fail-soft: a missing file, EACCES, malformed JSON, or any read error all
 * route silently to the env-fallback path. We deliberately do NOT log on
 * these — single-bridge installs simply will not have a secrets file, and a
 * noisy warning every connector call would be operator-hostile.
 *
 * Precedence on collision (file present AND env set): the FILE wins. Reasoning:
 * the file path exists exactly to override env. Once a deployment opts into
 * the file by writing it, env values would be stale leftovers (or, worse, the
 * exact leak we are hiding from `/proc/.../environ`). The contract is "file
 * takes over when present", documented here so operators can reason about it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Absolute path the helper reads from. */
export function secretsFilePath(): string {
  const patchworkHome =
    process.env.PATCHWORK_HOME ?? path.join(homedir(), ".patchwork");
  return path.join(patchworkHome, ".secrets.json");
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Loaded JSON object, or `null` when the file is absent / unreadable /
 * malformed. `undefined` means "not loaded yet". The two distinct states let
 * us only attempt the read once per process — even if the file is missing.
 */
let cached: Record<string, string> | null | undefined;

function load(): Record<string, string> | null {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(secretsFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Coerce to Record<string, string>; drop non-string values defensively.
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      cached = out;
      return cached;
    }
    cached = null;
    return null;
  } catch {
    // ENOENT / EACCES / SyntaxError — silent fallback to env.
    cached = null;
    return null;
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
    if (typeof v === "string" && v !== "") return v;
    // Empty string in the file → still try env (treat the file value as unset).
  }
  return process.env[name] ?? "";
}

/**
 * Test hook — clears the cached file read so a test can rewrite the secrets
 * file mid-run and observe the new value. Never called in production code.
 */
export function _resetSecretsCacheForTests(): void {
  cached = undefined;
}
