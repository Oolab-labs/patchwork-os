/**
 * ADR-0026 known bypass, closed: per-tool `assertWriteAllowed` (connector
 * tools) and the direct `isWriteKillSwitchActive()` reads in server.ts /
 * recipeRoutes.ts sat behind `executeTool` and were NOT profile-aware — an
 * unreadable kill-switch state resolved to the cached value (fail-OPEN) even
 * under the governed profile.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWriteAllowed,
  KILL_SWITCH_WRITES,
  setFlag,
} from "../../featureFlags.js";
import { _setKillSwitchReaderForTesting } from "../killSwitchPolicy.js";
import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../profile.js";

const ENV = "PATCHWORK_FLAG_KILL_SWITCH_WRITES";
const throwingReader = () => {
  throw new Error("flags.json unreadable");
};

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

beforeEach(() => {
  delete process.env[ENV];
  setFlag(KILL_SWITCH_WRITES, false);
  _setKillSwitchReaderForTesting(null);
  _resetActiveProfileForTesting();
});
afterEach(() => {
  delete process.env[ENV];
  setFlag(KILL_SWITCH_WRITES, false);
  _setKillSwitchReaderForTesting(null);
  _resetActiveProfileForTesting();
});

describe("assertWriteAllowed is profile-aware", () => {
  it("governed + unreadable state ⇒ refused with kill_switch_blocked", () => {
    setActiveProfile(GOVERNED_PROFILE);
    _setKillSwitchReaderForTesting(throwingReader);
    expect(codeOf(() => assertWriteAllowed("synthetic.create"))).toBe(
      "kill_switch_blocked",
    );
  });

  it("compat + unreadable state ⇒ unchanged historical fail-open", () => {
    _setKillSwitchReaderForTesting(throwingReader);
    expect(() => assertWriteAllowed("synthetic.create")).not.toThrow();
  });

  it("engaged ⇒ refused in both profiles, legacy message kept", () => {
    setFlag(KILL_SWITCH_WRITES, true);
    for (const governed of [false, true]) {
      if (governed) setActiveProfile(GOVERNED_PROFILE);
      let err: (Error & { code?: string }) | undefined;
      try {
        assertWriteAllowed("synthetic.create");
      } catch (e) {
        err = e as Error & { code?: string };
      }
      expect(err?.code).toBe("kill_switch_blocked");
      expect(err?.message).toMatch(
        /^Write operation blocked by kill switch: synthetic\.create\./,
      );
    }
  });

  it("released + readable ⇒ allowed in both profiles", () => {
    expect(() => assertWriteAllowed("x")).not.toThrow();
    setActiveProfile(GOVERNED_PROFILE);
    expect(() => assertWriteAllowed("x")).not.toThrow();
  });
});

// ── Source guards: anchored on the CALL, not a declaration ───────────────────

const SRC = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Text of the region starting at `anchor` (a route-specific literal). */
function region(src: string, anchor: string, len = 1500): string {
  const i = src.indexOf(anchor);
  expect(i, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  return src.slice(i, i + len);
}

describe("write-gating HTTP routes consult the profile-aware reader", () => {
  const server = read("server.ts");
  const routes = read("recipeRoutes.ts");

  const gating: Array<[string, string, string]> = [
    [
      "server.ts POST /settings",
      server,
      'pathname === "/settings" && req.method === "POST"',
    ],
    [
      "server.ts POST telemetry",
      server,
      "telemetry prefs are config writes too",
    ],
    [
      "recipeRoutes.ts install",
      routes,
      "Marketplace trust Wave 0 (#782 follow-up)",
    ],
  ];
  for (const [name, src, anchor] of gating) {
    it(`${name} gates on readKillSwitch()`, () => {
      const r = region(src, anchor);
      const gate = r.indexOf("readKillSwitch().engaged");
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(r).not.toMatch(/isWriteKillSwitchActive\(\)/);
      // The refusal status is written after the gate, before any body read.
      expect(r.indexOf("kill_switch_blocked")).toBeGreaterThan(gate);
    });
  }

  it("status reads (GET /kill-switch, copilot) never report released on an unreadable state", () => {
    const get = region(server, "const ks = readKillSwitch();", 400);
    expect(get).toMatch(/const ks = readKillSwitch\(\);/);
    const copilot = region(routes, "killSwitchEngaged:", 200);
    expect(copilot).toMatch(/readKillSwitch\(\)\.engaged/);
  });
});

/**
 * No production file outside featureFlags.ts / killSwitchPolicy.ts may call
 * isWriteKillSwitchActive() for a write decision. Each allowlisted call is a
 * justified NON-gating read.
 */
const ALLOWED_CALLS: Record<string, { count: number; reason: string }> = {
  "server.ts": {
    count: 1,
    reason:
      "POST /kill-switch `prev`: idempotence compare against the in-memory value setFlag() mutates. Not a write gate — the kill-switch toggle is the one route that must stay reachable while engaged or unreadable (writing the flag repairs an unreadable file).",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("isWriteKillSwitchActive() call-site allowlist", () => {
  it("only justified display reads remain", () => {
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join("/");
      if (rel === "featureFlags.ts" || rel === "governance/killSwitchPolicy.ts")
        continue;
      const n = (
        fs.readFileSync(f, "utf8").match(/isWriteKillSwitchActive\(\)/g) ?? []
      ).length;
      if (n > 0) found[rel] = n;
    }
    const expected = Object.fromEntries(
      Object.entries(ALLOWED_CALLS).map(([k, v]) => [k, v.count]),
    );
    expect(found).toEqual(expected);
  });
});
