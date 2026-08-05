/**
 * `PATCHWORK_HOME` and the config path.
 *
 * `docs/privacy-policy.md` states "`~/.patchwork/` respects the
 * `PATCHWORK_HOME` environment variable". `patchworkConfig` did not: both
 * `defaultConfigPath()` and the default `recipesDir` were built from a bare
 * `homedir()`, so a user who set the override got a split brain — tokens,
 * approvals and feature flags moved (those modules honour it), while their
 * config and recipes stayed behind and the process silently used defaults.
 *
 * It also made the TEST SUITE non-hermetic: `testEnvSetup` points
 * `PATCHWORK_HOME` at a temp dir, but config resolution ignored it and read
 * the developer's real `~/.patchwork/config.json`. That is how an agent step
 * with no pinned `driver` reached a live local model from inside a unit test:
 * the real config said `model: "local"`, so auto-detect chose `localFn`.
 *
 * There is deliberately NO silent fallback to the legacy path. It would keep
 * an existing override user working untouched, but it would equally re-import
 * the developer's real config into every test run — the half of this bug that
 * is hardest to see. The override wins, and `warnIfLegacyConfigStranded`
 * names both paths out loud so a stranded config isn't a silent one.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearConfigCache,
  defaultConfigPath,
  loadConfig,
} from "../patchworkConfig.js";
import {
  _resetLegacyWarning,
  patchworkHome,
  warnIfLegacyConfigStranded,
} from "../patchworkHome.js";

let overrideDir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.PATCHWORK_HOME;
  overrideDir = mkdtempSync(path.join(os.tmpdir(), "pw-home-"));
  process.env.PATCHWORK_HOME = overrideDir;
  clearConfigCache();
});
afterEach(() => {
  if (previous === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = previous;
  rmSync(overrideDir, { recursive: true, force: true });
  clearConfigCache();
});

describe("PATCHWORK_HOME — config path", () => {
  it("resolves the config inside the override, not the real home", () => {
    expect(defaultConfigPath()).toBe(path.join(overrideDir, "config.json"));
    expect(defaultConfigPath()).not.toContain(
      path.join(os.homedir(), ".patchwork"),
    );
  });

  it("reads a config written into the override directory", () => {
    writeFileSync(
      path.join(overrideDir, "config.json"),
      JSON.stringify({ model: "local", driver: "subprocess" }),
    );
    clearConfigCache();
    expect(loadConfig().model).toBe("local");
  });

  it("defaults recipesDir under the override too", () => {
    clearConfigCache();
    expect(loadConfig().recipesDir).toBe(path.join(overrideDir, "recipes"));
  });

  it("a test worker never reads the developer's real config", () => {
    // The hermeticity guarantee, stated as a test: whatever is in the
    // developer's ~/.patchwork/config.json must not reach a test run.
    clearConfigCache();
    const cfg = loadConfig();
    // An empty override dir ⇒ pure defaults.
    expect(cfg.model).toBe("claude");
  });

  it("does NOT fall back to the legacy config when the override is empty", () => {
    // A silent fallback would keep an existing override user working, but it
    // would also re-import the developer's real config into every test run —
    // the half of this bug that is hardest to see. Override wins; the warning
    // below is what keeps that from being silent.
    const empty = mkdtempSync(path.join(os.tmpdir(), "pw-empty-"));
    process.env.PATCHWORK_HOME = empty;
    clearConfigCache();
    expect(defaultConfigPath()).toBe(path.join(empty, "config.json"));
    expect(loadConfig().model).toBe("claude"); // defaults, not the real config
    rmSync(empty, { recursive: true, force: true });
  });

  it("warns, naming both paths, when a config is stranded in the legacy dir", () => {
    // The developer's real ~/.patchwork/config.json exists on this machine,
    // which is exactly the situation the warning is for.
    const legacy = path.join(os.homedir(), ".patchwork", "config.json");
    if (!existsSync(legacy)) return; // nothing stranded here; nothing to warn about
    _resetLegacyWarning();
    const lines: string[] = [];
    warnIfLegacyConfigStranded("config.json", (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(overrideDir);
    expect(lines[0]).toContain(legacy);
    expect(lines[0]).toMatch(/NOT being read/i);
  });

  it("warns only once, so a hot path can call it freely", () => {
    const legacy = path.join(os.homedir(), ".patchwork", "config.json");
    if (!existsSync(legacy)) return;
    _resetLegacyWarning();
    const lines: string[] = [];
    warnIfLegacyConfigStranded("config.json", (m) => lines.push(m));
    warnIfLegacyConfigStranded("config.json", (m) => lines.push(m));
    expect(lines).toHaveLength(1);
  });

  it("stays silent when no override is set", () => {
    delete process.env.PATCHWORK_HOME;
    _resetLegacyWarning();
    const lines: string[] = [];
    warnIfLegacyConfigStranded("config.json", (m) => lines.push(m));
    expect(lines).toEqual([]);
  });

  it("resolves a RELATIVE override to an absolute path", () => {
    // A relative root would re-point whenever the process changes directory,
    // and the bridge has a CwdChanged hook — so this is a live hazard.
    process.env.PATCHWORK_HOME = "relative/dir";
    expect(path.isAbsolute(patchworkHome())).toBe(true);
    expect(patchworkHome()).toBe(path.resolve("relative/dir"));
  });

  it("treats a whitespace-only override as unset", () => {
    process.env.PATCHWORK_HOME = "   ";
    expect(patchworkHome()).toBe(path.join(os.homedir(), ".patchwork"));
  });

  it("uses the real home when the override is unset", () => {
    delete process.env.PATCHWORK_HOME;
    clearConfigCache();
    expect(defaultConfigPath()).toBe(
      path.join(os.homedir(), ".patchwork", "config.json"),
    );
  });
});
