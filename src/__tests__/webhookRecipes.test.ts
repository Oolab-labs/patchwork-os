import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findWebhookRecipe,
  findYamlRecipePath,
  loadRecipeContent,
  loadRecipePrompt,
  renderWebhookPrompt,
  saveRecipe,
  saveRecipeContent,
} from "../recipesHttp.js";

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

  it("matches YAML webhook recipes and returns file metadata", () => {
    writeFileSync(
      path.join(tmp, "yaml-hook.yaml"),
      [
        "name: yaml-hook",
        "trigger:",
        "  type: webhook",
        "  path: /yaml-hook",
        "steps:",
        "  - tool: file.write",
        "    path: /tmp/out.txt",
        "    content: ok",
        "",
      ].join("\n"),
    );

    expect(findWebhookRecipe(tmp, "/yaml-hook")).toMatchObject({
      name: "yaml-hook",
      path: "/yaml-hook",
      filePath: path.join(tmp, "yaml-hook.yaml"),
      format: "yaml",
    });
  });

  it("matches YAML recipes by declared name when filename differs", () => {
    writeFileSync(
      path.join(tmp, "custom-filename.yaml"),
      [
        "name: declared-yaml-name",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - tool: file.write",
        "    path: /tmp/out.txt",
        "    content: ok",
        "",
      ].join("\n"),
    );

    expect(findYamlRecipePath(tmp, "declared-yaml-name")).toBe(
      path.join(tmp, "custom-filename.yaml"),
    );
  });
});

describe("loadRecipePrompt", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-load-prompt-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("falls back to matching a JSON recipe by declared name", () => {
    writeFileSync(
      path.join(tmp, "custom-filename.json"),
      JSON.stringify(
        {
          name: "deploy-trigger",
          description: "Deploy the service",
          steps: [{ id: "main", prompt: "ship it" }],
        },
        null,
        2,
      ),
    );

    const loaded = loadRecipePrompt(tmp, "deploy-trigger");
    expect(loaded).not.toBeNull();
    expect(loaded?.path).toBe(path.join(tmp, "custom-filename.json"));
    expect(loaded?.prompt).toContain('Patchwork recipe "deploy-trigger"');
  });
});

describe("loadRecipeContent / saveRecipeContent", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-recipe-content-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads YAML content by recipe name", () => {
    const yamlPath = path.join(tmp, "yaml-draft.yaml");
    writeFileSync(
      yamlPath,
      [
        "name: yaml-draft",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - tool: file.write",
        "    path: /tmp/out.txt",
        "    content: ok",
        "",
      ].join("\n"),
    );

    expect(loadRecipeContent(tmp, "yaml-draft")).toEqual({
      content: readFileSync(yamlPath, "utf-8"),
      path: yamlPath,
    });
  });

  it("falls back to JSON recipes matched by declared name", () => {
    const jsonPath = path.join(tmp, "custom-name.json");
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          name: "json-fallback",
          trigger: { type: "manual" },
          steps: [{ id: "step-1", agent: true, prompt: "ship it" }],
        },
        null,
        2,
      ),
    );

    expect(loadRecipeContent(tmp, "json-fallback")).toEqual({
      content: readFileSync(jsonPath, "utf-8"),
      path: jsonPath,
    });
  });

  it("saves YAML content to a named .yaml file", () => {
    const content = [
      "name: yaml-save",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - tool: file.write",
      "    path: /tmp/out.txt",
      "    content: ok",
    ].join("\n");

    const result = saveRecipeContent(tmp, "yaml-save", content);

    expect(result).toEqual({
      ok: true,
      path: path.join(tmp, "yaml-save.yaml"),
    });
    expect(readFileSync(path.join(tmp, "yaml-save.yaml"), "utf-8")).toBe(
      `${content}\n`,
    );
  });

  it("rejects invalid YAML recipes with validation errors", () => {
    const content = [
      "name: yaml-save",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - agent: {}",
    ].join("\n");

    expect(saveRecipeContent(tmp, "yaml-save", content)).toEqual({
      ok: false,
      error: "Step 1: Agent step missing 'prompt'",
    });
  });

  it("rejects blank raw recipe content", () => {
    expect(saveRecipeContent(tmp, "yaml-save", "   ")).toEqual({
      ok: false,
      error: "Recipe content is required",
    });
  });
});

describe("saveRecipe", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-save-recipe-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("normalizes schedule drafts to cron trigger JSON shape", () => {
    const result = saveRecipe(tmp, {
      name: "daily-report",
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      steps: [{ id: "step-1", agent: true, prompt: "ship it" }],
    });

    expect(result.ok).toBe(true);
    const saved = JSON.parse(
      readFileSync(path.join(tmp, "daily-report.json"), "utf-8"),
    ) as { trigger?: Record<string, string> };
    expect(saved.trigger).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
  });

  it("accepts already-normalized cron drafts", () => {
    const result = saveRecipe(tmp, {
      name: "hourly-report",
      trigger: { type: "cron", schedule: "@every 1h" },
      steps: [{ id: "step-1", agent: true, prompt: "ship it" }],
    });

    expect(result.ok).toBe(true);
    const saved = JSON.parse(
      readFileSync(path.join(tmp, "hourly-report.json"), "utf-8"),
    ) as { trigger?: Record<string, string> };
    expect(saved.trigger).toEqual({ type: "cron", schedule: "@every 1h" });
  });

  it("rejects webhook drafts without a leading slash path", () => {
    const result = saveRecipe(tmp, {
      name: "bad-hook",
      trigger: { type: "webhook", path: "bad-hook" },
      steps: [{ id: "step-1", agent: true, prompt: "ship it" }],
    });

    expect(result).toEqual({
      ok: false,
      error: "webhook trigger requires a path starting with /",
    });
  });

  it("rejects cron drafts without a schedule", () => {
    const result = saveRecipe(tmp, {
      name: "bad-cron",
      trigger: { type: "schedule", cron: "   " },
      steps: [{ id: "step-1", agent: true, prompt: "ship it" }],
    });

    expect(result).toEqual({
      ok: false,
      error: "cron trigger requires a schedule",
    });
  });

  it("rejects drafts without steps", () => {
    const result = saveRecipe(tmp, {
      name: "no-steps",
      trigger: { type: "manual" },
      steps: [],
    });

    expect(result).toEqual({
      ok: false,
      error: "Recipe must have at least one step",
    });
  });

  it("rejects drafts with duplicate step ids", () => {
    const result = saveRecipe(tmp, {
      name: "dup-steps",
      trigger: { type: "manual" },
      steps: [
        { id: "step-1", agent: true, prompt: "first" },
        { id: " step-1 ", agent: true, prompt: "second" },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: "Step 2 has a duplicate id",
    });
  });

  it("rejects drafts with duplicate variable names", () => {
    const result = saveRecipe(tmp, {
      name: "dup-vars",
      trigger: { type: "manual" },
      steps: [{ id: "step-1", agent: true, prompt: "ship it" }],
      vars: [{ name: "ticket_id" }, { name: " ticket_id " }],
    });

    expect(result).toEqual({
      ok: false,
      error: "Variable 2 has a duplicate name",
    });
  });

  it("rejects drafts with unknown template references", () => {
    const result = saveRecipe(tmp, {
      name: "bad-template",
      trigger: { type: "manual" },
      steps: [
        {
          id: "step-1",
          agent: true,
          prompt: "summarize {{missing_context_key}}",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown template reference/);
    expect(result.error).toContain("missing_context_key");
  });

  it("trims step ids and variable names when saving", () => {
    const result = saveRecipe(tmp, {
      name: "trimmed-fields",
      trigger: { type: "manual" },
      steps: [{ id: " step-1 ", agent: true, prompt: "ship it" }],
      vars: [{ name: " ticket_id " }],
    });

    expect(result.ok).toBe(true);
    const saved = JSON.parse(
      readFileSync(path.join(tmp, "trimmed-fields.json"), "utf-8"),
    ) as {
      steps?: Array<{ id: string }>;
      vars?: Array<{ name: string }>;
    };
    expect(saved.steps?.[0]?.id).toBe("step-1");
    expect(saved.vars?.[0]?.name).toBe("ticket_id");
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
