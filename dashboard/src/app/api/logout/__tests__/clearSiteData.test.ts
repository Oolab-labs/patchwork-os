/** @vitest-environment node */
/**
 * Security sweep L5. The service worker caches every same-origin HTML page it
 * fetches (network-first, cache fallback) — authenticated pages included. Logout
 * cleared only the cookie, so on a shared machine the next person offline could
 * be served the previous operator's cached approval queue.
 *
 * `Clear-Site-Data: "cache", "storage"` makes the browser drop CacheStorage
 * (where the SW cache lives — it falls under "storage", not "cache") and
 * unregister the service worker. "cookies" is deliberately NOT sent: the
 * session cookie is already cleared by Set-Cookie, and "cookies" would also
 * wipe unrelated cookies for the whole registrable domain.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/csrf", () => ({ requireSameOrigin: () => null }));

const { POST } = await import("../route");

describe("logout clears the service-worker cache (L5)", () => {
  it("sends Clear-Site-Data covering cache and storage", async () => {
    const res = await POST(new Request("http://localhost/api/logout", { method: "POST" }));
    const csd = res.headers.get("clear-site-data") ?? "";
    expect(csd).toContain('"cache"');
    expect(csd).toContain('"storage"');
    expect(csd).not.toContain('"cookies"');
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });
});
