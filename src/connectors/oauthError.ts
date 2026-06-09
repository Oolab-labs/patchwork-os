/**
 * Shared OAuth token-exchange error redaction.
 *
 * Audit 2026-06-09 HIGH (connector-new-1 / connector-new-2): IdP token-exchange
 * error bodies can embed access_token / refresh_token / error_description values
 * that are sensitive. Several connectors embedded the *raw* response body in a
 * thrown Error, which their callback handlers then surfaced verbatim into the
 * HTTP response (HTML or JSON) shown to the browser. Only the HTTP status and a
 * parsed, non-sensitive `error` code are safe to surface.
 *
 * `safeOAuthErrorCode` extracts the standard OAuth 2.0 `error` field (RFC 6749
 * §5.2) from a JSON or form-encoded error body, ignoring everything else. It
 * never returns free-form text from the body, so it cannot leak token values or
 * `error_description` detail.
 */

/** Parse only the OAuth `error` code from a token-exchange error body. */
export function safeOAuthErrorCode(body: string | null | undefined): string {
  if (!body) return "unknown";
  // JSON error body: { "error": "invalid_grant", ... }
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) {
      return sanitizeCode(parsed.error);
    }
  } catch {
    // not JSON — fall through to form-encoded
  }
  // Form-encoded error body: error=invalid_grant&...
  try {
    const code = new URLSearchParams(body).get("error");
    if (code) return sanitizeCode(code);
  } catch {
    // not parseable
  }
  return "unknown";
}

/**
 * OAuth error codes are short alphanumeric tokens (RFC 6749 §5.2). Clamp length
 * and strip anything unexpected so a hostile IdP can't smuggle a long secret in
 * via the `error` field itself.
 */
function sanitizeCode(code: string): string {
  const cleaned = code.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
  return cleaned || "unknown";
}
