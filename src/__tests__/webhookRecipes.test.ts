import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWebhookRecipe, renderWebhookPrompt } from "../recipesHttp.js";

describe("findWebhookRecipe", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-webhook-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeRecipe(filename: string, body: Record<string, unknown>) {
    writeFileSync(path.join(tmp, filename), JSON.stringify(body, null, 2));
  }

  it("returns the recipe whose webhook path matches exactly", () => {
    writeRecipe("a.json", {
      name: "deploy-trigger",
      version: "1",
      trigger: { type: "webhook", path: "/deploy" },
      steps: [{ id: "main", agent: true, prompt: "deploy" }],
    });
    writeRecipe("b.json", {
      name: "other",
      version: "1",
      trigger: { type: "cron", schedule: "@every 1m" },
      steps: [],
    });
    const match = findWebhookRecipe(tmp, "/deploy");
    expect(match?.name).toBe("deploy-trigger");
    expect(match?.path).toBe("/deploy");
  });

  it("returns null when no recipe matches the path", () => {
    writeRecipe("a.json", {
      name: "deploy",
      version: "1",
      trigger: { type: "webhook", path: "/deploy" },
      steps: [],
    });
    expect(findWebhookRecipe(tmp, "/nope")).toBeNull();
  });

  it("returns null for missing recipes dir", () => {
    expect(findWebhookRecipe(path.join(tmp, "none"), "/x")).toBeNull();
  });

  it("skips malformed files and continues scanning", () => {
    writeFileSync(path.join(tmp, "broken.json"), "{ not json");
    writeRecipe("good.json", {
      name: "ok",
      version: "1",
      trigger: { type: "webhook", path: "/ok" },
      steps: [],
    });
    expect(findWebhookRecipe(tmp, "/ok")?.name).toBe("ok");
  });

  it("ignores non-webhook recipes", () => {
    writeRecipe("c.json", {
      name: "m",
      version: "1",
      trigger: { type: "manual" },
      steps: [],
    });
    expect(findWebhookRecipe(tmp, "/m")).toBeNull();
  });
});

describe("renderWebhookPrompt", () => {
  it("appends the JSON body under a fenced code block", () => {
    const out = renderWebhookPrompt("base", { ok: true, n: 1 });
    expect(out).toMatch(/^base/);
    expect(out).toMatch(/Webhook payload:/);
    expect(out).toContain('"ok": true');
    expect(out).toContain("```json");
  });

  it("returns base unchanged when payload is undefined", () => {
    expect(renderWebhookPrompt("base", undefined)).toBe("base");
  });

  it("truncates oversized payloads", () => {
    const payload = { data: "x".repeat(20_000) };
    const out = renderWebhookPrompt("base", payload);
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThan(9_000);
  });
});
