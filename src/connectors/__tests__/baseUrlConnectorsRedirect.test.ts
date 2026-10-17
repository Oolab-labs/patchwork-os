/**
 * Connectors with an operator-supplied base URL (grafana, posthog, supabase,
 * woocommerce, caldiy) go through the shared outbound guard, with private
 * networks ALLOWED (audit M20, owner decision 2026-10-17: self-hosted
 * instances commonly live on private networks).
 *
 * What that buys, concretely: a redirect to a different origin no longer
 * carries the connector's credential. Native fetch drops `Authorization`
 * across origins but forwards custom key headers — measured: `apikey` and
 * `x-api-key` both arrived at the redirect target. Supabase sends its
 * service-role key as `apikey`.
 *
 * Real servers on loopback: A answers 307 to B on another origin, and B
 * records what it received.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let a: Server;
let b: Server;
let aUrl = "";
const seenAtB: IncomingHttpHeaders[] = [];
const home = mkdtempSync(join(tmpdir(), "base-url-redirect-"));

beforeAll(async () => {
  b = createServer((req, res) => {
    seenAtB.push(req.headers);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  // Both stacks: "localhost" may resolve to ::1, and the connection is
  // pinned to whatever it resolves to.
  await new Promise<void>((r) => b.listen(0, r));
  const bPort = (b.address() as AddressInfo).port;
  a = createServer((req, res) => {
    req.resume();
    // "localhost" vs "127.0.0.1": a different origin, still loopback.
    res.writeHead(307, { location: `http://localhost:${bPort}${req.url}` });
    res.end();
  });
  await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => a.close(() => r()));
  await new Promise<void>((r) => b.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

describe("a cross-origin redirect does not carry the connector's credential", () => {
  it("supabase: the service-role key in `apikey` is not forwarded", async () => {
    vi.stubEnv("PATCHWORK_HOME", home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "file");
    vi.stubEnv("SUPABASE_URL", aUrl);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-secret-value");
    vi.resetModules();
    try {
      const { getSupabaseConnector } = await import("../supabase.js");
      seenAtB.length = 0;
      await getSupabaseConnector()
        .select("notes")
        .catch(() => undefined);
      // The redirect is followed (private networks are allowed)…
      expect(seenAtB).toHaveLength(1);
      const h = seenAtB[0] as IncomingHttpHeaders;
      // …but the credential stays with the origin it was meant for.
      expect(h.apikey).toBeUndefined();
      expect(h.authorization).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
