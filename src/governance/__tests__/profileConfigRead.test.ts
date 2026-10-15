/**
 * A present-but-unparseable config.json must not resolve to compat.
 *
 * Audit 2026-10-15 (H1): the bridge and the local run path both wrapped
 * `loadConfig()` in an empty catch commented "no config.json ⇒ compat", but
 * `loadConfig` only returns cleanly for a MISSING file — a corrupt one throws,
 * and the catch turned that into compat with no log line. The whole governed
 * posture (containment, worker authority, gate floor, fail-closed kill switch)
 * was lost on a stray comma. `"Governed"` with a capital letter did the same
 * via `resolveProfile`, which accepts only the exact strings.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { governanceReport } from "../doctorReport.js";
import {
  ConfigUnreadableError,
  profileValueWarning,
  readProfileConfig,
} from "../profile.js";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-profile-cfg-"));
  mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readProfileConfig", () => {
  it("a MISSING config.json resolves to an empty input (compat, unchanged)", () => {
    const r = readProfileConfig({ configPath });
    expect(r.config.profile).toBeUndefined();
    expect(r.warning).toBeUndefined();
  });

  it("a PRESENT but unparseable config.json throws a named error, never compat", () => {
    writeFileSync(configPath, '{"profile":"governed",');
    expect(() => readProfileConfig({ configPath })).toThrow(
      ConfigUnreadableError,
    );
    try {
      readProfileConfig({ configPath });
    } catch (err) {
      expect((err as ConfigUnreadableError).code).toBe("config_unreadable");
      expect((err as Error).message).toContain("config.json");
      expect((err as Error).message).toContain("unparseable");
    }
  });

  it("a well-formed governed config is returned as-is with no warning", () => {
    writeFileSync(configPath, '{"profile":"governed"}');
    const r = readProfileConfig({ configPath });
    expect(r.config.profile).toBe("governed");
    expect(r.warning).toBeUndefined();
  });

  it("a profile value that is not exactly governed|compat carries a warning", () => {
    writeFileSync(configPath, '{"profile":"Governed"}');
    const r = readProfileConfig({ configPath });
    expect(r.warning).toContain('"Governed"');
    expect(r.warning).toContain("governed");
    expect(r.warning).toContain("compat");
  });
});

describe("profileValueWarning", () => {
  it("is silent for absent and for the two accepted spellings", () => {
    expect(profileValueWarning(undefined)).toBeUndefined();
    expect(profileValueWarning("governed")).toBeUndefined();
    expect(profileValueWarning("compat")).toBeUndefined();
  });
  it("names the value and the accepted spellings otherwise", () => {
    const w = profileValueWarning("Governed");
    expect(w).toContain('"Governed"');
    expect(w).toMatch(/governed.*compat|compat.*governed/);
    expect(profileValueWarning(1)).toContain("1");
  });
});

describe("doctor reports an unrecognised profile value as the NOT GOVERNED reason", () => {
  it("says the value is unrecognised, not that the key is absent", () => {
    const report = governanceReport({
      config: { profile: "Governed" } as never,
      isFlagOn: () => false,
      recipesDir: dir,
      workersDir: dir,
    });
    const line = report.lines.find((l) => l.key === "profile");
    expect(line?.status).toBe("fail");
    expect(line?.value).toContain("unrecognised");
    expect(line?.value).not.toContain("no profile: key");
    expect(report.reasons.join("\n")).toContain('"Governed"');
  });
});
