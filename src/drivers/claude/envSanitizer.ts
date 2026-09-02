/**
 * Strip env vars that would cause the subprocess to attach to or authenticate
 * as the parent Claude Code session.
 *
 * `CLAUDECODE` and most `CLAUDE_CODE_*` / `MCP_*` vars are set by a running
 * Claude Code session for its child processes and would make the spawned
 * subprocess re-authenticate against, or behave as a nested agent of, that
 * parent.
 *
 * EXCEPTION: `CLAUDE_CODE_OAUTH_TOKEN` is the official long-lived
 * subscription auth env (issued by `claude setup-token`). Stripping it would
 * de-authenticate the subprocess entirely — recipes running under a
 * subscription would all fail with "Not logged in · Please run /login".
 * Preserve it.
 *
 * This fix was originally shipped in PR #777 but was lost in the squash-merge
 * (see chore(release) commit aa89d0de touching this file). Re-applied here.
 */
const PRESERVE = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Cross-provider LLM credentials (Tier-0 #3, audit 2026-06-22).
 *
 * A bridge-spawned subprocess agent authenticates as exactly ONE provider.
 * Every OTHER provider's API key sitting in its environment is pure
 * exfiltration surface — a prompt-injected agent can read it with `printenv`
 * and ship it out with a single `curl`. The sanitizer previously stripped only
 * Anthropic/MCP vars, so OPENAI/XAI/GEMINI/etc. keys leaked into both the
 * Claude and Gemini subprocess drivers.
 *
 * These are stripped by default. A driver that legitimately needs one of them
 * (e.g. the Gemini driver needs GEMINI_API_KEY / GOOGLE_*) passes the keys it
 * needs via the `preserve` option so only the OTHER providers' keys are removed.
 */
const CROSS_PROVIDER_SECRETS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "COHERE_API_KEY",
  "DEEPSEEK_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "OPENROUTER_API_KEY",
  "FIREWORKS_API_KEY",
  "REPLICATE_API_TOKEN",
]);

export interface SanitizeEnvOptions {
  /**
   * Provider-credential env keys to KEEP even though they would otherwise be
   * stripped as cross-provider secrets. Used by a driver to retain its own
   * provider's credentials (e.g. the Gemini driver preserves GEMINI_API_KEY).
   */
  preserve?: Iterable<string>;
}

export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  opts?: SanitizeEnvOptions,
): NodeJS.ProcessEnv {
  const preserve = new Set(PRESERVE);
  for (const key of opts?.preserve ?? []) preserve.add(key);

  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(clean)) {
    if (preserve.has(key)) continue;
    if (
      key === "CLAUDECODE" ||
      key === "ANTHROPIC_API_KEY" ||
      key.startsWith("CLAUDE_CODE_") ||
      key.startsWith("MCP_") ||
      CROSS_PROVIDER_SECRETS.has(key)
    ) {
      delete clean[key];
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Allowlist mode (Phase 0 step 6 — governed agent containment).
//
// `sanitizeEnv` above is a DENYLIST: it removes what it knows about, and
// everything it has never heard of reaches the child. On a bridge host that
// means connector tokens (JIRA_API_TOKEN, NOTION_TOKEN, *_CLIENT_SECRET),
// DASHBOARD_PASSWORD, GITHUB_TOKEN, CLAUDE_IDE_BRIDGE_TOKEN,
// BRIDGE_WEBHOOK_SECRET and every PATCHWORK_* setting — all readable by a
// prompt-injected agent with one `printenv`. Under a governed profile the
// child receives ONLY what is listed here, plus the one provider credential
// the driver authenticates with, plus keys the recipe declared explicitly.
// ---------------------------------------------------------------------------

/** Exact keys a contained child always receives (when set in the parent). */
export const ENV_ALLOWLIST_EXACT: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows: without these the child cannot resolve %APPDATA% / drive
  // letters and every npm-installed CLI fails to start.
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SystemDrive",
]);

/** Prefixes a contained child always receives. */
export const ENV_ALLOWLIST_PREFIXES: readonly string[] = Object.freeze([
  "LC_",
  "XDG_",
]);

/**
 * Deliberately NOT allowlisted, and never allowable via `passEnv`:
 * `NODE_OPTIONS` (`--require` a payload into every Node child) and the
 * parent-session markers `sanitizeEnv` strips. A recipe cannot re-open these
 * by declaring them — the declaration is dropped and reported.
 */
const NEVER_PASS = new Set(["NODE_OPTIONS", "CLAUDECODE"]);
function neverPass(key: string): boolean {
  return (
    NEVER_PASS.has(key) ||
    key.startsWith("MCP_") ||
    (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN")
  );
}

export interface AllowlistEnvOptions {
  /**
   * The provider credential(s) THIS driver authenticates with, e.g.
   * `["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]` for Claude,
   * `["GEMINI_API_KEY", ...]` for Gemini, `["OPENAI_API_KEY"]` for Codex.
   * Exactly one provider's keys — never every provider's.
   */
  providerKeys?: Iterable<string>;
  /**
   * Keys the recipe declared it needs (`providerOptions.passEnv`). Passed
   * through by exact name; a declared key that is a never-pass marker is
   * dropped and listed in the result's `dropped`.
   */
  passEnv?: Iterable<string>;
}

export interface AllowlistEnvResult {
  env: NodeJS.ProcessEnv;
  /** `passEnv` entries refused because they are never-pass markers. */
  dropped: string[];
}

/** Pure: does `key` pass the base allowlist (no provider / passEnv input)? */
export function isBaseAllowlistedEnvKey(key: string): boolean {
  if (neverPass(key)) return false;
  if (ENV_ALLOWLIST_EXACT.includes(key)) return true;
  return ENV_ALLOWLIST_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * ALLOWLIST the child environment. Everything not named — every connector
 * token, bridge secret and PATCHWORK_* setting — is dropped. Returns a new
 * object; the input is never mutated.
 */
export function allowlistEnvDetailed(
  env: NodeJS.ProcessEnv,
  opts?: AllowlistEnvOptions,
): AllowlistEnvResult {
  const extra = new Set<string>();
  const dropped: string[] = [];
  for (const k of opts?.providerKeys ?? []) extra.add(k);
  for (const k of opts?.passEnv ?? []) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (neverPass(k)) {
      dropped.push(k);
      continue;
    }
    extra.add(k);
  }
  const clean: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    if (isBaseAllowlistedEnvKey(key) || (extra.has(key) && !neverPass(key))) {
      clean[key] = env[key];
    }
  }
  return { env: clean, dropped };
}

/** Convenience form of `allowlistEnvDetailed` returning only the env. */
export function allowlistEnv(
  env: NodeJS.ProcessEnv,
  opts?: AllowlistEnvOptions,
): NodeJS.ProcessEnv {
  return allowlistEnvDetailed(env, opts).env;
}

/**
 * Read a recipe's declared `passEnv` out of the untyped providerOptions bag.
 * Non-string entries are ignored rather than coerced.
 */
export function passEnvFromProviderOptions(
  opts: Record<string, unknown> | undefined,
): string[] {
  const raw = opts?.passEnv;
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string" && k.length > 0);
}
