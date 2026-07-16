/**
 * Same regression as the recipe detail page's page.revalidate.test.ts:
 * fetchRegistry() / fetchBundleManifest() were called with no `opts`,
 * falling back to fetchGithubFile's independent 300s fetch-cache default
 * instead of matching this route's `revalidate = 60`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound() called");
  }),
}));

import BundleDetailPage from "../page";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const REGISTRY = {
  version: "1",
  updated_at: "2026-01-01T00:00:00Z",
  recipes: [],
  bundles: [
    {
      name: "@patchworkos/example-bundle",
      version: "1.0.0",
      description: "example bundle",
      install: "github:patchworkos/recipes/bundles/example",
    },
  ],
};

describe("BundleDetailPage — fetch-cache revalidate wiring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes revalidate=60 (not fetchGithubFile's 300s default) to registry + bundle manifest fetches", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(REGISTRY)) // fetchRegistry → index.json
      .mockResolvedValueOnce(
        jsonResponse({
          name: "example-bundle",
          version: "1.0.0",
          recipes: ["a-recipe"],
        }),
      ); // fetchBundleManifest → patchwork-bundle.json

    await BundleDetailPage({
      params: Promise.resolve({ slug: ["@patchworkos", "example-bundle"] }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { next?: { revalidate?: number } } | undefined;
      expect(init?.next?.revalidate).toBe(60);
    }
  });
});
