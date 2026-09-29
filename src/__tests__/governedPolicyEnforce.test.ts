/**
 * `profile: governed` must enforce `patchwork.policy.yml` at runtime — not only
 * in what `patchwork doctor` reports.
 *
 * The same defect #1614 closed for the worker gate, on the policy matrix: the
 * profile carries `policyEnforce: true` and doctor credits it, but every
 * runtime check (the recipe tool check, the WebSocket gate and the HTTP gate)
 * consulted only `FLAG_ENFORCE_POLICY`. The bridge flips that flag in memory
 * under governed, which an operator's `PATCHWORK_FLAG_POLICY_ENFORCE=0`, a
 * `flags.json` reload, or a process that publishes the profile without the
 * flag all undo silently — doctor then says ENFORCED while a forbidden path is
 * written.
 *
 * The profile is published with `setActiveProfile(resolveProfile(...))` as
 * `bridge.ts` does; the flag is left at its default or forced off by env.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAG_ENFORCE_POLICY, isEnabled, setFlag } from "../featureFlags.js";
import { governanceReport } from "../governance/doctorReport.js";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../governance/profile.js";
import type { loadConfig } from "../patchworkConfig.js";
import { enforceToolPolicy } from "../recipes/toolPolicyCheck.js";

const ENV_KEY = "PATCHWORK_FLAG_POLICY_ENFORCE";
const POLICY = 'version: 1\ndefaults:\n  forbiddenPaths:\n    - "secrets/**"\n';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-gov-policy-"));
  writeFileSync(path.join(dir, "patchwork.policy.yml"), POLICY);
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  setFlag(FLAG_ENFORCE_POLICY, false, false);
  _resetActiveProfileForTesting();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  setFlag(FLAG_ENFORCE_POLICY, false, false);
  _resetActiveProfileForTesting();
  rmSync(dir, { recursive: true, force: true });
});

const publish = (profile?: string) =>
  setActiveProfile(
    resolveProfile(
      (profile ? { profile } : {}) as ReturnType<typeof loadConfig>,
    ),
  );

/** True when the runtime refuses a write to a forbidden path. */
function runtimeEnforces(): boolean {
  try {
    enforceToolPolicy(
      "file.write",
      { path: "secrets/key.txt" },
      { workdir: dir },
    );
    return false;
  } catch (err) {
    return String((err as Error).message).startsWith("policy_denied");
  }
}

describe("governed profile enforces the policy matrix at runtime", () => {
  it("governed + flag unset → a forbidden path is refused", () => {
    publish("governed");
    expect(runtimeEnforces()).toBe(true);
  });

  it("governed + env explicitly 0 → still refused (the profile turns it ON)", () => {
    publish("governed");
    process.env[ENV_KEY] = "0";
    expect(runtimeEnforces()).toBe(true);
  });

  it("control: compat + flag unset → not enforced (byte-identical to before)", () => {
    publish("compat");
    expect(runtimeEnforces()).toBe(false);
  });

  it("control: no profile + flag unset → not enforced", () => {
    publish();
    expect(runtimeEnforces()).toBe(false);
  });

  it("control: compat + flag set via env → enforced", () => {
    publish("compat");
    process.env[ENV_KEY] = "1";
    expect(runtimeEnforces()).toBe(true);
  });
});

describe("doctor reports exactly what the runtime enforces", () => {
  const cases: Array<{ profile: string | undefined; flag: boolean }> = [
    { profile: "governed", flag: false },
    { profile: "governed", flag: true },
    { profile: "compat", flag: false },
    { profile: "compat", flag: true },
    { profile: undefined, flag: false },
  ];
  for (const c of cases) {
    for (const live of [false, true]) {
      it(`profile=${c.profile ?? "(absent)"} flag=${c.flag} live=${live}`, () => {
        const config = (c.profile ? { profile: c.profile } : {}) as ReturnType<
          typeof loadConfig
        >;
        setActiveProfile(resolveProfile(config));
        if (c.flag) process.env[ENV_KEY] = "1";
        const report = governanceReport({
          config,
          isFlagOn: isEnabled,
          recipesDir: dir,
          workersDir: dir,
          live,
        });
        const line = report.lines.find((l) => l.key === "policyMatrix");
        expect(line).toBeDefined();
        expect(line?.value.startsWith("ENFORCED")).toBe(runtimeEnforces());
      });
    }
  }
});

describe("every runtime policy check uses the shared predicate", () => {
  // The WebSocket and HTTP gates are not reachable without a live transport;
  // pin them at the source so a direct flag read cannot come back unnoticed.
  for (const file of [
    "bridge.ts",
    "streamableHttp.ts",
    "recipes/toolPolicyCheck.ts",
  ]) {
    it(`${file} does not gate on FLAG_ENFORCE_POLICY directly`, () => {
      const src = readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(src).not.toMatch(/isEnabled\(\s*FLAG_ENFORCE_POLICY\s*\)/);
      expect(src).toMatch(/policyEnforcementEnabled\(/);
    });
  }
});
