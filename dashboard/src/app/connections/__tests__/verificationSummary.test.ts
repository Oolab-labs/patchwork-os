/**
 * The connections page must say whether a credential has been PROVEN to work,
 * not just that one is stored (audit 2026-10-15, H9). "Connected" alone meant
 * a credential existed; the Test outcome the bridge recorded was never shown,
 * and the connector's connect time was rendered as "Last sync".
 */
import { describe, expect, it } from "vitest";
import { recentlyUsedOrder, verificationSummary } from "../verificationSummary";

describe("verificationSummary", () => {
  it("names each state in words, with when it was established", () => {
    const v = verificationSummary({
      id: "x",
      status: "connected",
      verification: "verified",
      lastCheck: { at: "2026-10-01T00:00:00.000Z", ok: true },
    });
    expect(v?.state).toBe("verified");
    expect(v?.label).toBe("Verified");
    expect(v?.title).toContain("Test passed");

    const f = verificationSummary({
      id: "x",
      status: "connected",
      verification: "failed",
      lastCheck: { at: "2026-10-02T00:00:00.000Z", ok: false, reason: "failed" },
    });
    expect(f?.label).toBe("Test failed");
    expect(f?.title).toMatch(/Test again|reconnect/);

    const u = verificationSummary({ id: "x", status: "connected", verification: "unverified" });
    expect(u?.label).toBe("Not verified");
    expect(u?.title).toContain("run Test");
  });

  it("says nothing when the bridge sent no verification (older bridge)", () => {
    expect(verificationSummary({ id: "x", status: "connected" })).toBeNull();
  });

  it("says nothing for a connector that is not connected", () => {
    expect(
      verificationSummary({ id: "x", status: "disconnected", verification: "unverified" }),
    ).toBeNull();
  });
});

describe("recentlyUsedOrder", () => {
  it("ranks by a real successful call, never by connect time", () => {
    const order = recentlyUsedOrder([
      { id: "connected-long-ago-used-today", status: "connected", connectedAt: "2026-01-01T00:00:00Z", lastSuccessAt: "2026-10-16T09:00:00Z" },
      { id: "connected-yesterday-never-used", status: "connected", connectedAt: "2026-10-15T00:00:00Z", lastSync: "2026-10-15T00:00:00Z" },
      { id: "used-last-week", status: "connected", lastSuccessAt: "2026-10-09T00:00:00Z" },
      { id: "disconnected", status: "disconnected", lastSuccessAt: "2026-10-16T10:00:00Z" },
    ]);
    expect(order).toEqual(["connected-long-ago-used-today", "used-last-week"]);
  });
});
