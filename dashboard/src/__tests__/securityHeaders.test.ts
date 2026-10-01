/** @vitest-environment node */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// next.config.js is CommonJS; load it the way Next does.
const require = createRequire(import.meta.url);
const nextConfig = require(
  path.resolve(__dirname, "../../next.config.js"),
) as {
  poweredByHeader?: boolean;
  headers?: () => Promise<
    Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  >;
};

/**
 * The dashboard is served on the session-cookie origin and hosts the
 * approve / reject / kill-switch controls. Until now it shipped NO security
 * headers of its own — the only ones in the repo were on the BRIDGE nginx
 * server block, which does not serve the dashboard — so clickjacking of
 * those controls was mitigated by `SameSite=Strict` alone, and a default
 * local install or any non-nginx deploy got nothing. These are set at the
 * app so every deployment shape carries them.
 */
describe("dashboard security headers (next.config.js)", () => {
  it("disables the X-Powered-By fingerprint", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("applies anti-framing, nosniff and referrer headers to every route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers?.();
    const all = rules?.find((r) => r.source === "/(.*)");
    expect(all, "a catch-all header rule").toBeDefined();
    const get = (key: string) =>
      all?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())
        ?.value;

    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(get("Permissions-Policy")).toBeDefined();
  });
});
