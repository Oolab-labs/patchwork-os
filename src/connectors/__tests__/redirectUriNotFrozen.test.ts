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
  /**
   * Match the INITIALIZER, not the identifier.
   *
   * The previous guard was `/^const\s+REDIRECT_URI\s*=/m` — an exact name, in
   * an exact shape. `REDIRECT_URI` appears nowhere in `src/connectors/` any
   * more; every connector now uses lowercase `redirectUri()`. So the guard was
   * watching a spelling the codebase had stopped using, and the likeliest
   * regression — `const redirectUri = connectorRedirectUri("new-vendor")` —
   * passed it untouched, as would `export const …`, an indented declaration,
   * or any other name.
   *
   * What actually defines the defect is not what the binding is CALLED but
   * that a module-level binding CAPTURES the result: `connectorCallbackBase()`
   * reads `process.env` per call, so freezing its output at import is the bug
   * regardless of the identifier.
   *
   * `\s` matches newlines, so this catches the wrapped form a formatter
   * produces once the call gets long — the exact shape that hid a hardcoded
   * path from `audit-patchwork-home` for months (#1265).
   */
  const FROZEN_AT_IMPORT =
    /^(?:export\s+)?const\s+\w+\s*=\s*(?:connectorRedirectUri|connectorCallbackBase)\s*\(/m;

  it("no connector captures the redirect URI in a module-level binding", async () => {
    // A source-level assertion because the defect IS the binding site: a
    // behavioural test of one connector would pass while another stayed
    // frozen, and this is exactly the drift class the issue describes.
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "src", "connectors");
    const offenders: string[] = [];
    let scanned = 0;
    // RECURSIVE. The old scan was one level deep while its commit message said
    // "anywhere in src/connectors/" — a claim the code did not implement.
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      if (f.includes("__tests__")) continue;
      scanned++;
      const src = readFileSync(path.join(dir, f), "utf-8");
      if (FROZEN_AT_IMPORT.test(src)) offenders.push(f);
    }
    // Anchor: a scan that silently walked zero files would report "no
    // offenders" forever. This whole guard existed in that state.
    expect(scanned).toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });

  it("the guard actually matches a frozen binding (control)", () => {
    // Proves the predicate can fail. Every spelling below is one the old
    // identifier-exact regex let through.
    for (const bad of [
      'const REDIRECT_URI = connectorRedirectUri("x");',
      'const redirectUri = connectorRedirectUri("x");',
      "export const cb = connectorCallbackBase();",
      'const wrapped =\n  connectorRedirectUri("x");',
    ]) {
      expect(FROZEN_AT_IMPORT.test(bad)).toBe(true);
    }
    // And does NOT match the per-call form every connector now uses.
    for (const good of [
      'function redirectUri(): string {\n  return connectorRedirectUri("x");\n}',
      'const url = () => connectorRedirectUri("x");',
    ]) {
      expect(FROZEN_AT_IMPORT.test(good)).toBe(false);
    }
  });
});
