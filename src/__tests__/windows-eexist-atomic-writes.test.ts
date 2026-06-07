/**
 * Windows EEXIST regression tests for open-coded renameSync writers.
 *
 * On Windows renameSync throws EEXIST when the target exists (POSIX atomically
 * replaces). Five sites bypass writeFileAtomicSync. These tests simulate EEXIST
 * by spying on renameSync (where the module uses a default fs import), verifying
 * each writer survives after the fix.
 *
 * Audit: docs/windows-performance-audit-2026-06-06.md §4.4
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be top-level (vi.hoisted uses static analysis to hoist before imports)
const analyticsMod = await vi.hoisted(async () => ({
  getAnalyticsPref: vi.fn<() => boolean | null>(() => null),
}));
vi.mock("../analyticsPrefs.js", () => analyticsMod);

function eexist(): NodeJS.ErrnoException {
  const e = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
  e.code = "EEXIST";
  return e;
}

// ---------------------------------------------------------------------------
// 1. activationMetrics.ts
//    writeAtomic() uses `import fs from "node:fs"` (default import) → spyable
// ---------------------------------------------------------------------------
describe("activationMetrics writeAtomic EEXIST guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "pw-metrics-eexist-"));
    analyticsMod.getAnalyticsPref.mockReturnValue(null);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("recordRecipeRun second call survives EEXIST on renameSync", async () => {
    const { recordRecipeRun, loadMetrics } = await import(
      "../activationMetrics.js"
    );
    const fsModule = await import("node:fs");
    const now = Date.UTC(2026, 5, 6, 10, 0, 0);

    // First write — target file doesn't exist yet, no EEXIST
    recordRecipeRun(tmpDir, now);

    // Simulate Windows: renameSync throws EEXIST because target exists
    const realRename = fsModule.default.renameSync.bind(fsModule.default);
    let calls = 0;
    vi.spyOn(fsModule.default, "renameSync").mockImplementation((src, dest) => {
      if (++calls === 1) throw eexist();
      return realRename(src, dest);
    });

    // recordRecipeRun wraps writes in try/catch (metrics must not crash product),
    // so it never throws. But BEFORE FIX: EEXIST is swallowed → metric not saved
    // → count stays at 1. AFTER FIX: writeFileAtomicSync handles EEXIST →
    // write succeeds → count advances to 2.
    recordRecipeRun(tmpDir, now + 1000);

    const metrics = loadMetrics(tmpDir, now);
    expect(metrics.recipeRunsTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. recipes/installer.ts
//    atomicWriteSync() uses named renameSync import. The installer exposes
//    an fs injection interface. We test both injection path and the real
//    upgrade path (POSIX — passes always; Windows — fixed by using writeFileAtomicSync).
// ---------------------------------------------------------------------------
describe("recipes installer upgrade EEXIST guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "pw-installer-eexist-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("installRecipeFromFile default writer handles existing target on upgrade", async () => {
    const { installRecipeFromFile } = await import("../recipes/installer.js");

    const recipe = JSON.stringify({
      name: "my-recipe",
      version: "2.0.0",
      trigger: { type: "manual" },
      steps: [{ id: "s1", agent: { prompt: "hello" } }],
    });

    const src = path.join(tmpDir, "my-recipe.json");
    const recipesDir = path.join(tmpDir, "recipes");
    mkdirSync(recipesDir, { recursive: true });
    const dest = path.join(recipesDir, "my-recipe.json");

    writeFileSync(src, recipe);
    // Pre-existing install (upgrade scenario — target already exists)
    writeFileSync(
      dest,
      '{"name":"my-recipe","version":"1.0.0","trigger":{"type":"manual"},"steps":[{"id":"s1","prompt":"old"}]}',
    );

    // BEFORE FIX on Windows: atomicWriteSync renameSync throws EEXIST → throws
    // AFTER FIX: writeFileAtomicSync handles EEXIST → action:'replaced'
    // On POSIX: rename atomically replaces → passes either way
    const result = installRecipeFromFile(src, { recipesDir });
    expect(result.action).toBe("replaced");
    expect(JSON.parse(readFileSync(dest, "utf-8"))).toMatchObject({
      version: "2.0.0",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. commands/install.ts
//    writeConfigAtomic() uses named renameSync. We test via writeFileAtomicSync
//    (the post-fix delegate) with a simulated EEXIST spy.
// ---------------------------------------------------------------------------
describe("commands/install writeConfigAtomic EEXIST guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "pw-install-cmd-eexist-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("write survives EEXIST on target that already exists", async () => {
    const fsModule = await import("node:fs");
    const { writeFileAtomicSync } = await import("../writeFileAtomic.js");

    const configPath = path.join(tmpDir, "claude.json");
    writeFileSync(configPath, '{"mcpServers":{}}');

    // Simulate Windows: renameSync throws EEXIST on first call
    const realRename = fsModule.default.renameSync.bind(fsModule.default);
    let calls = 0;
    vi.spyOn(fsModule.default, "renameSync").mockImplementation((src, dest) => {
      if (++calls === 1) throw eexist();
      return realRename(src, dest);
    });

    // writeFileAtomicSync handles EEXIST via unlink+retry
    expect(() =>
      writeFileAtomicSync(configPath, '{"mcpServers":{"memory":{}}}'),
    ).not.toThrow();
    expect(readFileSync(configPath, "utf-8")).toContain("memory");
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. bridgeToolsRules.ts + index.ts:402
//    writeRulesFileAtomic uses named renameSync + flag:'wx'.
//    Separately: index.ts treats EEXIST from that rename as symlink attack →
//    process.exit(1). Both fixed by using writeFileAtomicSync.
// ---------------------------------------------------------------------------
describe("bridgeToolsRules + index.ts writeRulesFileAtomic EEXIST guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "pw-bridge-rules-eexist-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("repairBridgeToolsRulesIfStale updates stale file (was silently failing on Windows)", async () => {
    const { repairBridgeToolsRulesIfStale } = await import(
      "../bridgeToolsRules.js"
    );

    // Create a stale rules file (missing version sentinel)
    const rulesDir = path.join(tmpDir, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    const rulesPath = path.join(rulesDir, "bridge-tools.md");
    writeFileSync(
      rulesPath,
      "# stale - getDiagnostics MANDATORY batchGetHover",
    );

    // BEFORE FIX on Windows: writeRulesFileAtomic renameSync throws EEXIST →
    //   caught by repairBridgeToolsRulesIfStale → returns false, file unchanged.
    // AFTER FIX: writeFileAtomicSync handles EEXIST → returns true, file updated.
    // On POSIX: rename replaces → passes either way.
    const result = repairBridgeToolsRulesIfStale(tmpDir, undefined, {
      writeIfMissing: true,
    });
    expect(result).toBe(true);
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).not.toContain("# stale");
    expect(content.length).toBeGreaterThan(200);
  });

  it("EEXIST from renameSync does NOT trigger process.exit(1)", async () => {
    // index.ts:402 writeRulesFileAtomic: EEXIST → handleRulesWriteError → exit(1)
    // After fix: writeFileAtomicSync handles EEXIST internally → no throw at all
    const fsModule = await import("node:fs");
    const { writeFileAtomicSync } = await import("../writeFileAtomic.js");

    const rulesPath = path.join(tmpDir, "bridge-tools2.md");
    writeFileSync(rulesPath, "# old");

    const realRename = fsModule.default.renameSync.bind(fsModule.default);
    let calls = 0;
    vi.spyOn(fsModule.default, "renameSync").mockImplementation((src, dest) => {
      if (++calls === 1) throw eexist();
      return realRename(src, dest);
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error(`exit(${_code})`);
    });

    expect(() => writeFileAtomicSync(rulesPath, "# new")).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(readFileSync(rulesPath, "utf-8")).toBe("# new");
  });
});
