import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectorRedirectUri } from "../connectorRedirectUri.js";

/**
 * #1266 defect 1 — the redirect URI must track the environment at CALL time.
 *
 * Six connectors bound it to a module-level `const`, freezing whichever base
 * URL existed when the module first loaded. Any later change was ignored and
 * the connector kept building auth URLs against a stale base, with no error:
 * the failure surfaces at the OAuth provider as a redirect_uri mismatch, far
 * from its cause.
 */
const KEYS = ["PATCHWORK_DASHBOARD_URL", "PATCHWORK_BRIDGE_URL"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("connectorRedirectUri reflects the environment at call time", () => {
  it("changes when the dashboard URL changes between calls", () => {
    process.env.PATCHWORK_DASHBOARD_URL = "https://first.example.test";
    const before = connectorRedirectUri("gmail");
    process.env.PATCHWORK_DASHBOARD_URL = "https://second.example.test";
    const after = connectorRedirectUri("gmail");

    expect(before).toContain("first.example.test");
    expect(after).toContain("second.example.test");
    // The whole point: a value captured once cannot do this.
    expect(after).not.toBe(before);
  });

  it("falls back to the bridge URL, then to a default", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.test";
    expect(connectorRedirectUri("monday")).toContain("bridge.example.test");

    delete process.env.PATCHWORK_BRIDGE_URL;
    expect(connectorRedirectUri("monday")).toMatch(/^https?:\/\//);
  });

  it("keeps the per-connector callback path", () => {
    process.env.PATCHWORK_DASHBOARD_URL = "https://host.example.test";
    for (const slug of [
      "gmail",
      "google-calendar",
      "google-drive",
      "google-docs",
      "salesforce",
      "monday",
    ]) {
      expect(connectorRedirectUri(slug)).toBe(
        `https://host.example.test/connections/${slug}/callback`,
      );
    }
  });
});

describe("no connector freezes the redirect URI at import (#1266)", () => {
  it("has no module-level REDIRECT_URI constant left", async () => {
    // A source-level assertion because the defect IS the binding site: a
    // behavioural test of one connector would pass while another stayed
    // frozen, and this is exactly the drift class the issue describes.
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "src", "connectors");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(path.join(dir, f), "utf-8");
      if (/^const\s+REDIRECT_URI\s*=/m.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
