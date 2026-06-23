/**
 * Tier-1 #7 (audit 2026-06-22) — SSRF guard on user-supplied connector URLs.
 *
 * The prior-audit fix added isPrivateHost() guards to the four DB connectors
 * (postgres/redis/mongodb/elasticsearch). Four sibling HTTP connectors that
 * also open connections to a user-supplied URL — posthog, caldiy, woocommerce,
 * supabase — still lacked the guard, so a caller could point the URL at cloud
 * IMDS (169.254.169.254) or an RFC-1918 host and have the bridge POST the
 * credential there. These tests assert the connect handlers now reject
 * private/loopback/link-local hosts (and non-https) before any fetch.
 */

import { describe, expect, it } from "vitest";

describe("connector connect-handler SSRF guards (Tier-1 #7)", () => {
  it("posthog: rejects https host pointing at the cloud metadata IP", async () => {
    const { handlePostHogConnect } = await import("../posthog.js");
    const r = await handlePostHogConnect(
      JSON.stringify({ apiKey: "phx_test", host: "https://169.254.169.254" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });

  it("posthog: rejects an RFC-1918 host", async () => {
    const { handlePostHogConnect } = await import("../posthog.js");
    const r = await handlePostHogConnect(
      JSON.stringify({ apiKey: "phx_test", host: "https://10.1.2.3" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });

  it("caldiy: rejects loopback baseUrl", async () => {
    const { handleCalDiyConnect } = await import("../caldiy.js");
    const r = await handleCalDiyConnect(
      JSON.stringify({ apiKey: "cal_test", baseUrl: "https://127.0.0.1" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });

  it("caldiy: rejects plain http baseUrl (https required)", async () => {
    const { handleCalDiyConnect } = await import("../caldiy.js");
    const r = await handleCalDiyConnect(
      JSON.stringify({ apiKey: "cal_test", baseUrl: "http://cal.example.com" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/https/i);
  });

  it("woocommerce: rejects RFC-1918 storeUrl", async () => {
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const r = await handleWooCommerceConnect(
      JSON.stringify({
        consumerKey: "ck_test",
        consumerSecret: "cs_test",
        storeUrl: "https://10.0.0.5",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });

  it("woocommerce: rejects the cloud metadata IP", async () => {
    const { handleWooCommerceConnect } = await import("../woocommerce.js");
    const r = await handleWooCommerceConnect(
      JSON.stringify({
        consumerKey: "ck_test",
        consumerSecret: "cs_test",
        storeUrl: "https://169.254.169.254",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });

  it("supabase: rejects loopback url", async () => {
    const { handleSupabaseConnect } = await import("../supabase.js");
    const r = await handleSupabaseConnect(
      JSON.stringify({ url: "https://127.0.0.1", serviceRoleKey: "srk_test" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });

  it("supabase: rejects the cloud metadata IP", async () => {
    const { handleSupabaseConnect } = await import("../supabase.js");
    const r = await handleSupabaseConnect(
      JSON.stringify({
        url: "https://169.254.169.254",
        serviceRoleKey: "srk_test",
      }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/private|loopback|link-local/i);
  });
});
