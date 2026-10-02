/**
 * Refuse dashboard auth configured with the `.env.example` placeholders or a
 * short session secret (security sweep L7). The secret is the HMAC key for
 * session cookies, so a known or short value lets anyone mint a session.
 *
 * Only the shipped password placeholder is refused: a hand-set password may
 * legitimately be short, and refusing it would lock out a working install.
 * Messages name the variable, never its value. Edge-runtime safe (no imports).
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

const PASSWORD_PLACEHOLDERS = new Set(["changeme"]);
const SECRET_PLACEHOLDERS = new Set(["replace-with-32-byte-random-secret"]);

export function weakAuthConfig(password: string, secret: string): string | null {
  if (PASSWORD_PLACEHOLDERS.has(password)) {
    return "DASHBOARD_PASSWORD is still the .env.example placeholder. Set a real password.";
  }
  if (SECRET_PLACEHOLDERS.has(secret)) {
    return "DASHBOARD_SESSION_SECRET is still the .env.example placeholder. Generate one with: openssl rand -hex 32";
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return `DASHBOARD_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`;
  }
  return null;
}
