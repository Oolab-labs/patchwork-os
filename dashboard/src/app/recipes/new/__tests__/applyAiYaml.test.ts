/** @vitest-environment node */
/**
 * Regression tests for the AI Generate-with-AI save flow.
 *
 * Background: prior to PR #274 the dashboard /recipes/new page projected
 * AI-generated YAML through a form model that only knew `agent:` steps.
 * Any `tool:` / `parallel:` / `branch:` / `recipe:` step was silently
 * rewritten to an empty agent step on save. The fix saves the YAML
 * verbatim via PUT /api/bridge/recipes/:name and redirects to the
 * YAML editor. These tests guard the verbatim-body contract so a
 * future refactor can't re-introduce the lossy projection.
 */

import { describe, expect, it, vi } from "vitest";
import { prepareAndSaveAiRecipe } from "../applyAiYaml";

vi.mock("@/lib/api", () => ({
  apiPath: (p: string) => p,
}));

function okResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("prepareAndSaveAiRecipe — verbatim YAML round-trip", () => {
  it("PUTs the original `tool:` YAML unchanged (PR #274 regression)", async () => {
    const yaml = `apiVersion: patchwork.sh/v1
name: morning-inbox
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: 24h
    max: 30
    into: messages
  - tool: github.list_issues
    assignee: "@me"
    max: 10
    into: issues
`;
    const fetcher = vi.fn(async () => okResponse({ ok: true })) as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result).toEqual({ ok: true, recipeName: "morning-inbox" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe("/api/bridge/recipes/morning-inbox");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(init?.body as string) as { content: string };
    expect(body.content).toBe(yaml);
    // The verbatim contract: tool IDs and their params must survive.
    expect(body.content).toContain("tool: gmail.fetch_unread");
    expect(body.content).toContain("since: 24h");
    expect(body.content).toContain("max: 30");
    expect(body.content).toContain("tool: github.list_issues");
  });

  it("preserves `parallel:` step groups verbatim", async () => {
    const yaml = `apiVersion: patchwork.sh/v1
name: triage-and-notify
trigger:
  type: manual
steps:
  - parallel:
      - id: fetch_emails
        tool: gmail.fetch_unread
        max: 50
      - id: fetch_issues
        tool: github.list_issues
        assignee: "@me"
`;
    const fetcher = vi.fn(async () => okResponse({ ok: true })) as unknown as typeof fetch;

    await prepareAndSaveAiRecipe(yaml, fetcher);

    const [, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    const body = JSON.parse(init?.body as string) as { content: string };
    expect(body.content).toBe(yaml);
    expect(body.content).toContain("parallel:");
    expect(body.content).toContain("tool: gmail.fetch_unread");
  });

  it("preserves nested `recipe:` step references verbatim", async () => {
    const yaml = `apiVersion: patchwork.sh/v1
name: pipeline
trigger:
  type: manual
steps:
  - recipe: shared-fetch-step
    inputs:
      lookback: 7d
`;
    const fetcher = vi.fn(async () => okResponse({ ok: true })) as unknown as typeof fetch;

    await prepareAndSaveAiRecipe(yaml, fetcher);

    const [, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    const body = JSON.parse(init?.body as string) as { content: string };
    expect(body.content).toBe(yaml);
    expect(body.content).toContain("recipe: shared-fetch-step");
    expect(body.content).toContain("lookback: 7d");
  });
});

describe("prepareAndSaveAiRecipe — name extraction + slug", () => {
  it("normalizes the recipe name into the URL", async () => {
    const yaml = `name: My_Recipe Name\ntrigger: { type: manual }\nsteps: []\n`;
    const fetcher = vi.fn(async () => okResponse({ ok: true })) as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result).toEqual({ ok: true, recipeName: "my-recipe-name" });
    const [url] = (fetcher as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(url).toBe("/api/bridge/recipes/my-recipe-name");
  });

  it("rejects YAML with no parsable name", async () => {
    const yaml = `apiVersion: patchwork.sh/v1\ntrigger: { type: manual }\nsteps: []\n`;
    const fetcher = vi.fn() as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing a valid name/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects YAML that cannot be parsed", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe("name: foo\n  bad: [", fetcher);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not valid YAML/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("prepareAndSaveAiRecipe — error + demo paths", () => {
  it("surfaces a save error from the bridge", async () => {
    const yaml = `name: ok-recipe\ntrigger: { type: manual }\nsteps: []\n`;
    const fetcher = vi.fn(async () =>
      errorResponse(422, { ok: false, error: "Recipe failed lint." }),
    ) as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result).toEqual({ ok: false, error: "Recipe failed lint." });
  });

  it("blocks redirect in demo mode", async () => {
    const yaml = `name: demo-recipe\ntrigger: { type: manual }\nsteps: []\n`;
    const fetcher = vi.fn(async () =>
      okResponse({ ok: true, demo: true }),
    ) as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.demoBlocked).toBe(true);
      expect(result.error).toMatch(/Demo mode/);
    }
  });

  it("returns warnings alongside ok=true so caller can stash them", async () => {
    const yaml = `name: warn-recipe\ntrigger: { type: manual }\nsteps: []\n`;
    const fetcher = vi.fn(async () =>
      okResponse({ ok: true, warnings: ["unknown tool id: foo"] }),
    ) as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result).toEqual({
      ok: true,
      recipeName: "warn-recipe",
      warnings: ["unknown tool id: foo"],
    });
  });

  it("recovers from a fetch network error", async () => {
    const yaml = `name: net-fail\ntrigger: { type: manual }\nsteps: []\n`;
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await prepareAndSaveAiRecipe(yaml, fetcher);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ECONNREFUSED");
    }
  });
});
