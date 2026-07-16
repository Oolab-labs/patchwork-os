/**
 * Regression: the recipe detail page's `export const revalidate = 60`
 * governs the ROUTE SEGMENT's re-render cadence, but fetchRegistry() /
 * fetchManifest() / fetchRecipeYaml() were called with no `opts`, so each
 * underlying fetch() fell back to fetchGithubFile's own independent
 * `next: { revalidate }` fetch-cache default of 300s (registry.ts).
 *
 * Next's per-fetch data cache and the route segment's ISR revalidate are
 * separate caching layers — the page could re-render every 60s while
 * still being served a manifest/YAML fetch cached for up to 5x longer.
 * This specifically weakened the trust-divergence gate (#1185/#1186),
 * which depends on fetching the CURRENT recipe YAML to detect when it
 * contradicts the registry's self-reported risk metadata.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound() called");
  }),
}));

import RecipeDetailPage from "../page";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

const REGISTRY = {
  version: "1",
  updated_at: "2026-01-01T00:00:00Z",
  recipes: [
    {
      name: "@patchworkos/example",
      version: "1.0.0",
      description: "example",
      tags: [],
      connectors: [],
      downloads: 0,
      install: "github:patchworkos/recipes/recipes/example",
    },
  ],
};

describe("RecipeDetailPage — fetch-cache revalidate wiring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes revalidate=60 (not fetchGithubFile's 300s default) to every registry/manifest/YAML fetch", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(REGISTRY)) // fetchRegistry → index.json
      .mockResolvedValueOnce(
        jsonResponse({
          name: "example",
          version: "1.0.0",
          recipes: { main: "recipe.yaml" },
        }),
      ) // fetchManifest → recipe.json
      .mockResolvedValueOnce(textResponse("steps: []\n")); // fetchRecipeYaml → recipe.yaml

    await RecipeDetailPage({
      params: Promise.resolve({ slug: ["@patchworkos", "example"] }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { next?: { revalidate?: number } } | undefined;
      expect(init?.next?.revalidate).toBe(60);
    }
  });
});
