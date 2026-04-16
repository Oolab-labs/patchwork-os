/**
 * Pure utility functions for automation hook prompt assembly.
 * No side effects, no Date.now(), no process.*, no fs.*.
 */

/** Maximum byte length of an automation policy prompt (matches runClaudeTask cap) */
export const MAX_POLICY_PROMPT_CHARS = 32_768;

/** Maximum length (chars) of a file path inserted into prompts */
export const MAX_FILE_PATH_CHARS = 500;

/**
 * Wrap an untrusted user-controlled value in delimiters that include a
 * per-trigger nonce so a crafted value cannot forge a closing delimiter.
 * The nonce is stripped from the value itself before insertion.
 */
export function untrustedBlock(
  label: string,
  value: string,
  nonce: string,
): string {
  if (!/^[A-Z][A-Z0-9 ]*$/.test(label)) {
    throw new Error(
      `untrustedBlock: label must be uppercase ASCII, got: ${JSON.stringify(label)}`,
    );
  }
  // Use literal string replacement (not RegExp) — nonce is an opaque ID that
  // may contain regex metacharacters (e.g. "[", "+", ".").  RegExp would throw
  // SyntaxError for those inputs, enabling a DoS on every hook trigger.
  const safe = value.split(nonce).join("");
  return `\n--- BEGIN ${label} [${nonce}] (untrusted) ---\n${safe}\n--- END ${label} [${nonce}] ---\n`;
}

/**
 * Truncate a final prompt to MAX_POLICY_PROMPT_CHARS bytes at the last newline
 * before the limit and append a truncation notice.
 *
 * Uses Buffer byte-length rather than JS string .length (UTF-16 code units) so
 * that multibyte characters (emoji, CJK, surrogate pairs) are never split at a
 * code-unit boundary, which would produce malformed text.
 */
export function truncatePrompt(prompt: string): string {
  // Buffer.byteLength counts actual UTF-8 bytes, not UTF-16 code units.
  if (Buffer.byteLength(prompt, "utf8") <= MAX_POLICY_PROMPT_CHARS)
    return prompt;

  // Slice to MAX_POLICY_PROMPT_CHARS bytes then decode — Node.js drops any
  // incomplete multibyte sequence at the boundary automatically.
  let truncated = Buffer.from(prompt, "utf8")
    .subarray(0, MAX_POLICY_PROMPT_CHARS)
    .toString("utf8");

  // Prefer breaking at the last newline so we don't cut mid-sentence.
  const lastNl = truncated.lastIndexOf("\n");
  if (lastNl > 0) {
    truncated = truncated.slice(0, lastNl);
  }

  return `${truncated}\n[... truncated to fit 32KB limit ...]`;
}

/**
 * Build a trusted metadata prefix that is prepended to every automation hook
 * prompt BEFORE any untrustedBlock() substitutions.
 *
 * `nowIso` is injected by caller (e.g. `new Date().toISOString()`) so this
 * function remains deterministic in tests.
 */
export function buildHookMetadata(
  hookName: string,
  nowIso: string,
  file?: string,
): string {
  const safeFile = file
    ? file.slice(0, MAX_FILE_PATH_CHARS).replace(/[\x00-\x1F\x7F]/g, "")
    : "N/A";
  return `@@ HOOK: ${hookName} | file: ${safeFile} | ts: ${nowIso} @@\n`;
}
