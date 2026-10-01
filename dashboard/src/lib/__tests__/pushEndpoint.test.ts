/** @vitest-environment node */
/**
 * `/api/push/subscribe` stored whatever `endpoint` the body carried, and the
 * relay routes then `https.request`ed it on every fan-out via web-push. An
 * authenticated dashboard user could make the dashboard server POST
 * encrypted push payloads to any host and port — including RFC 1918 — with
 * no response shown (blind SSRF). Security sweep 2026-10-01, L2.
 *
 * A push endpoint is an HTTPS URL on a public host with no credentials in
 * it. Nothing else is a push service.
 */
import { describe, expect, it } from "vitest";
import { validatePushEndpoint } from "../pushEndpoint";

describe("validatePushEndpoint", () => {
  it("accepts a public https endpoint", () => {
    expect(
      validatePushEndpoint("https://push.example.test/send/abc123"),
    ).toEqual({ ok: true });
  });

  it.each([
    ["not a URL", "push.example.test/send"],
    ["http", "http://push.example.test/send"],
    ["ftp", "ftp://push.example.test/send"],
    ["credentials in URL", "https://user:pw@push.example.test/send"],
  ])("rejects %s", (_label, endpoint) => {
    expect(validatePushEndpoint(endpoint).ok).toBe(false);
  });

  it.each([
    ["loopback", "https://127.0.0.1/send"],
    ["localhost", "https://localhost/send"],
    ["RFC1918 10/8", "https://10.0.0.5/send"],
    ["RFC1918 192.168/16", "https://192.168.1.1:8443/send"],
    ["link-local / metadata", "https://169.254.169.254/latest"],
    ["IPv6 loopback", "https://[::1]/send"],
    ["decimal IPv4", "https://2130706433/send"],
  ])("rejects a private or loopback host (%s)", (_label, endpoint) => {
    expect(validatePushEndpoint(endpoint).ok).toBe(false);
  });

  it("gives a reason a 400 body can carry, never the URL back", () => {
    const r = validatePushEndpoint("https://10.0.0.5/send");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(typeof r.reason).toBe("string");
      expect(r.reason).not.toContain("10.0.0.5");
    }
  });
});
