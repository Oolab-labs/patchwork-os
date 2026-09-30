/**
 * Is `next` safe to hand to `window.location.replace` after login?
 *
 * ONE implementation, deliberately. `/api/login` and the login page each
 * carried their own copy of this check, and both had the same hole: they
 * looked at the first two characters (`//`, `/\`) and nothing else. The
 * WHATWG URL parser strips ASCII tab and newline BEFORE it parses, so
 * `/\t/example.test` — which starts with `/` and whose second character is
 * neither `/` nor `\` — resolves to `https://example.test/` in every browser.
 * A post-login open redirect, reachable from the `?next=` a phishing link
 * can set. Two copies of a guard are two places to miss the next such case.
 *
 * The check: a string, starting with `/`, whose second character is not `/`
 * or `\`, containing NO control character (0x00-0x1F, 0x7F) anywhere. The
 * control-character rule is what closes the parser-stripping class as a
 * whole rather than the two characters known today.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function isSafeRedirect(next: unknown): next is string {
  if (typeof next !== "string" || next.length === 0) return false;
  if (!next.startsWith("/")) return false;
  // Protocol-relative (`//host`) and its backslash spelling (`/\host`), which
  // browsers normalise to the same thing.
  if (next.startsWith("//")) return false;
  if (next.startsWith("/\\")) return false;
  if (CONTROL_CHAR_RE.test(next)) return false;
  return true;
}
