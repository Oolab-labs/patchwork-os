/**
 * #1361 — a hand edit to `config.json` must not be silently discarded.
 *
 * `loadConfig` caches for 30 seconds with NO check against the file. Every
 * runtime write is a read-modify-write built on that read (recipe
 * enable/disable, `POST /config/patchwork`), so an operator editing the file
 * by hand inside the window has their change read back as the pre-edit copy
 * and written straight over. No error, no conflict, no log line — the edit is
 * simply gone, and the next read shows the bridge's version, which looks
 * correct.
 *
 * That is why disabling `approval-gate-demo` by editing the file did not stick
 * and had to be routed through the bridge instead.
 *
 * The fix mirrors a pattern this codebase already uses: the outcome-log cache
 * is gated on `(mtimeMs, size)` for the same reason. Gating the READ fixes
 * every consumer, not only the write path — a stale read is wrong on its own
 * terms, quite apart from what a later write does with it.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, loadConfig } from "../patchworkConfig.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cfgcache-"));
  configPath = path.join(dir, "config.json");
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

/** Write the file and force a distinct mtime, so the test cannot pass merely
 *  because two writes landed in the same filesystem timestamp tick. */
const writeConfig = (obj: unknown, ageOffsetSec = 0) => {
  writeFileSync(configPath, JSON.stringify(obj, null, 2));
  if (ageOffsetSec) {
    const t = new Date(Date.now() + ageOffsetSec * 1000);
    utimesSync(configPath, t, t);
  }
};

describe("config cache staleness (#1361)", () => {
  it("sees an edit made to the file after the first read", () => {
    writeConfig({ model: "claude" });
    expect(loadConfig(configPath).model).toBe("claude");

    // The operator edits the file by hand, well inside the 30s TTL.
    writeConfig({ model: "gemini" }, 2);

    expect(
      loadConfig(configPath).model,
      "a hand edit must not be invisible to the next read — that read is what " +
        "every runtime write is built on",
    ).toBe("gemini");
  });

  /**
   * The clobber itself, in the shape it actually occurs: read (cached),
   * modify, write. If the read was stale, the write silently reverts the
   * operator's edit.
   */
  it("a read-modify-write does not revert a concurrent hand edit", () => {
    writeConfig({ model: "claude", recipes: { disabled: [] } });
    loadConfig(configPath); // warm the cache, as a running bridge would have

    // Operator disables a recipe by editing the file directly.
    writeConfig(
      { model: "claude", recipes: { disabled: ["approval-gate-demo"] } },
      2,
    );

    // The bridge now does its own unrelated update, built on a fresh read.
    const current = loadConfig(configPath);
    const next = { ...current, model: "gemini" };
    writeFileSync(configPath, JSON.stringify(next, null, 2));

    const after = JSON.parse(readFileSync(configPath, "utf8")) as {
      recipes?: { disabled?: string[] };
    };
    expect(
      after.recipes?.disabled,
      "the operator's edit must survive an unrelated bridge write",
    ).toEqual(["approval-gate-demo"]);
  });

  /** The cache must still BE a cache — an unchanged file should not be
   *  re-read and re-parsed on every call, or a hot path pays for this fix. */
  it("still serves repeated reads of an unchanged file from cache", () => {
    writeConfig({ model: "claude" });
    const first = loadConfig(configPath);
    const second = loadConfig(configPath);
    expect(second, "same object identity ⇒ served from cache").toBe(first);
    expect(statSync(configPath).size).toBeGreaterThan(0);
  });
});
