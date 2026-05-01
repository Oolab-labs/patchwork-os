/**
 * Redacts sensitive material from log/error strings before they reach
 * stdout/stderr. Used to wrap top-level `console.error` calls so a stack
 * trace from FCM/APNS init failures cannot leak PEM bodies or service
 * account secrets.
 *
 * Two redaction passes:
 *   1. Multi-line PEM blocks: anything between `-----BEGIN .* PRIVATE KEY-----`
 *      and the matching `-----END .* PRIVATE KEY-----` (incl. delimiters)
 *      becomes `[redacted PEM]`.
 *   2. Long base64-ish runs (≥40 chars of `[A-Za-z0-9_\-+/=.]`) become
 *      `[redacted token]`. Length floor avoids redacting normal words.
 */

const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// 40+ chars of base64-ish content. Lookbehind/word-boundary not used because
// keys often appear after `=` or `:` which are not word chars.
const LONG_TOKEN_RE = /[A-Za-z0-9_\-+/=.]{40,}/g;

export function redactSecrets(input: unknown): string {
  const s = typeof input === "string" ? input : String(input);
  return s
    .replace(PEM_BLOCK_RE, "[redacted PEM]")
    .replace(LONG_TOKEN_RE, "[redacted token]");
}

/**
 * Logs to stderr after running `redactSecrets` over each argument. Use in
 * place of `console.error` for any message that may include credential
 * material (top-level catches, FCM/APNS init paths, etc.).
 */
export function logErrorSafe(...args: unknown[]): void {
  const safe = args.map((a) => {
    if (a instanceof Error) {
      return redactSecrets(a.stack ?? a.message);
    }
    return redactSecrets(a);
  });
  console.error(...safe);
}
