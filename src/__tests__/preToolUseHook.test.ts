import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPreToolUseHookRegistered,
  registerPreToolUseHook,
} from "../preToolUseHook.js";

let dir: string;
let settingsPath: string;
const hookScript = "/opt/patchwork/scripts/patchwork-approval-hook.sh";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-init-"));
  settingsPath = path.join(dir, "settings.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readSettings() {
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as {
    hooks?: Record<string, unknown>;
    permissions?: unknown;
  };
}

describe("registerPreToolUseHook", () => {
  it("creates fresh settings.json with PreToolUse entry", () => {
    const r = registerPreToolUseHook(settingsPath, {
      hookScriptPath: hookScript,
    });
    expect(r.action).toBe("added");
    const s = readSettings();
    const pre = (s.hooks as Record<string, unknown[]>)?.PreToolUse;
    expect(pre).toBeDefined();
    expect(pre).toHaveLength(1);
    expect(JSON.stringify(pre)).toContain("patchwork-approval-hook.sh");
  });

  it("is idempotent — second call reports already-wired", () => {
    registerPreToolUseHook(settingsPath, { hookScriptPath: hookScript });
    const r2 = registerPreToolUseHook(settingsPath, {
      hookScriptPath: hookScript,
    });
    expect(r2.action).toBe("already-wired");
    const pre = (readSettings().hooks as Record<string, unknown[]>).PreToolUse;
    expect(pre).toHaveLength(1);
  });

  it("preserves existing hooks and other settings", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          PreCompact: [
            { matcher: "", hooks: [{ type: "command", command: "x" }] },
          ],
        },
      }),
    );
    const r = registerPreToolUseHook(settingsPath, {
      hookScriptPath: hookScript,
    });
    expect(r.action).toBe("added");
    const s = readSettings();
    expect(s.permissions).toEqual({ allow: ["Read"] });
    expect((s.hooks as Record<string, unknown>).PreCompact).toBeDefined();
    expect((s.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
  });

  it("migrates legacy flat hook shape to matcher+hooks", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ type: "command", command: "legacy" }],
        },
      }),
    );
    registerPreToolUseHook(settingsPath, { hookScriptPath: hookScript });
    const pre = (readSettings().hooks as Record<string, unknown[]>)
      .PreToolUse as Array<{ matcher?: string; hooks?: unknown[] }>;
    expect(pre.every((e) => Array.isArray(e.hooks))).toBe(true);
  });

  it("quotes paths that contain spaces", () => {
    const r = registerPreToolUseHook(settingsPath, {
      hookScriptPath: "/opt/Program Files/hook.sh",
    });
    expect(r.hookCommand).toContain('"/opt/Program Files/hook.sh"');
  });

  it("surfaces error when settings.json is malformed", () => {
    writeFileSync(settingsPath, "{not json");
    const r = registerPreToolUseHook(settingsPath, {
      hookScriptPath: hookScript,
    });
    expect(r.action).toBe("error");
    expect(r.error).toBeDefined();
  });
});

describe("isPreToolUseHookRegistered", () => {
  it("returns false when settings file does not exist", () => {
    expect(isPreToolUseHookRegistered(settingsPath)).toBe(false);
  });

  it("returns false when settings has no PreToolUse hooks", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    expect(isPreToolUseHookRegistered(settingsPath)).toBe(false);
  });

  it("returns true after registerPreToolUseHook runs successfully", () => {
    registerPreToolUseHook(settingsPath, { hookScriptPath: hookScript });
    expect(isPreToolUseHookRegistered(settingsPath)).toBe(true);
  });

  it("returns false when an unrelated PreToolUse hook is registered", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "/some/other/hook.sh" }],
            },
          ],
        },
      }),
    );
    expect(isPreToolUseHookRegistered(settingsPath)).toBe(false);
  });

  it("does not throw on malformed settings.json", () => {
    writeFileSync(settingsPath, "{not json");
    expect(() => isPreToolUseHookRegistered(settingsPath)).not.toThrow();
    expect(isPreToolUseHookRegistered(settingsPath)).toBe(false);
  });
});
