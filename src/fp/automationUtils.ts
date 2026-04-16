/**
 * Pure utility functions for automation hook prompt assembly.
 * No side effects, no Date.now(), no process.*, no fs.*.
 */

/** Maximum length (chars) of an automation policy prompt template (matches runClaudeTask cap) */
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
  const safe = value.replace(new RegExp(nonce, "g"), "");
  return `\n--- BEGIN ${label} [${nonce}] (untrusted) ---\n${safe}\n--- END ${label} [${nonce}] ---\n`;
}

/**
 * Truncate a final prompt to MAX_POLICY_PROMPT_CHARS at the last newline before
 * the limit and append a truncation notice.
 */
export function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_POLICY_PROMPT_CHARS) return prompt;
  const cutoff = prompt.lastIndexOf("\n", MAX_POLICY_PROMPT_CHARS);
  const end = cutoff > 0 ? cutoff : MAX_POLICY_PROMPT_CHARS;
  return `${prompt.slice(0, end)}\n[... truncated to fit 32KB limit ...]`;
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
