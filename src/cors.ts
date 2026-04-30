/**
 * CORS origin validator. Extracted from server.ts so that route modules
 * (mcpRoutes.ts, etc.) can use it without circular imports.
 */

/**
 * Return the CORS origin to reflect, or null if the origin is untrusted.
 * Loopback origins are always allowed. Additional origins can be passed via
 * --cors-origin (e.g. https://claude.ai for remote deployments).
 */
export function corsOrigin(
  requestOrigin: string | undefined,
  extraOrigins: string[] = [],
): string | null {
  if (!requestOrigin) return null;
  if (extraOrigins.includes(requestOrigin)) return requestOrigin;
  try {
    const { hostname, protocol } = new URL(requestOrigin);
    if (
      protocol === "http:" &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]")
    ) {
      return requestOrigin;
    }
  } catch {
    // malformed origin — deny
  }
  return null;
}
