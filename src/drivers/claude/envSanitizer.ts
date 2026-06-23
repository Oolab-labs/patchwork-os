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
