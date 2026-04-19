import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPatchworkInit } from "../commands/patchworkInit.js";

describe("patchwork-init", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "pw-init-"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no ollama")));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("scaffolds ~/.patchwork and copies recipe templates", async () => {
    const result = await runPatchworkInit([], { home: fakeHome, quiet: true });

    expect(existsSync(join(fakeHome, ".patchwork"))).toBe(true);
    expect(existsSync(join(fakeHome, ".patchwork", "recipes"))).toBe(true);
    expect(existsSync(join(fakeHome, ".patchwork", "inbox"))).toBe(true);
    expect(existsSync(join(fakeHome, ".patchwork", "journal"))).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);

    const recipes = readdirSync(result.recipesDir);
    expect(recipes).toContain("ambient-journal.yaml");
    expect(result.recipesCopied).toBeGreaterThanOrEqual(5);
    expect(result.configAction).toBe("created");
  });

  it("preserves an existing config by default (merge, don't clobber)", async () => {
    const cfgPath = join(fakeHome, ".patchwork", "config.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(fakeHome, ".patchwork"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        model: "openai",
        dashboard: {
          port: 9999,
          requireApproval: ["high"],
          pushNotifications: false,
        },
      }),
    );

    const result = await runPatchworkInit([], { home: fakeHome, quiet: true });
    const after = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(after.model).toBe("openai");
    expect(after.dashboard.port).toBe(9999);
    expect(result.configAction).toBe("merged");
  });

  it("sets model=local when Ollama is detected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));
    const result = await runPatchworkInit([], { home: fakeHome, quiet: true });
    expect(result.ollamaDetected).toBe(true);
    const cfg = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(cfg.model).toBe("local");
    expect(cfg.localEndpoint).toBe("http://localhost:11434");
  });

  it("skips Ollama detection with --no-ollama", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPatchworkInit(["--no-ollama"], {
      home: fakeHome,
      quiet: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ollamaDetected).toBe(false);
  });

  it("is idempotent — second run preserves copied recipes", async () => {
    const first = await runPatchworkInit([], { home: fakeHome, quiet: true });
    const second = await runPatchworkInit([], { home: fakeHome, quiet: true });
    expect(second.recipesCopied).toBe(0);
    expect(second.recipesSkipped).toBe(first.recipesCopied);
  });
});
