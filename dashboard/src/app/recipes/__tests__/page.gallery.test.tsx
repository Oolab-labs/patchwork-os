/**
 * Gallery redesign of the Recipes page (feat/dashboard-recipes-gallery).
 *
 * The page was migrated from a 7-column <table> to a responsive card grid.
 * These tests assert the presentation contract that replaced the table:
 *   1. one card renders per installed recipe (via `data-recipe-row`)
 *   2. the trigger/status filter chips narrow the visible cards
 *
 * The page uses useSearchParams()/useRouter() — without the app-router
 * context those hooks throw, so mock next/navigation (empty params + no-op
 * router), matching the sibling insights test.
 */

import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/recipes",
}));

import RecipesPage from "@/app/recipes/page";

const RECIPES = [
  { name: "cron-alpha", trigger: "cron", enabled: true, description: "scheduled one" },
  { name: "cron-beta", trigger: "cron", enabled: true, description: "scheduled two" },
  { name: "hook-gamma", trigger: "webhook", enabled: true, description: "webhook one" },
  { name: "manual-delta", trigger: "manual", enabled: false, description: "paused manual" },
];

function fetchMock(url: string): Response {
  if (url.includes("/api/bridge/recipes") && !url.includes("/run")) {
    return new Response(JSON.stringify({ recipes: RECIPES }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  // /api/bridge/runs
  return new Response(JSON.stringify({ runs: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Recipes gallery — card grid + filter chips", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => fetchMock(String(input))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders one card per recipe", async () => {
    const { container } = render(<RecipesPage />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".recipes-gallery-card[data-recipe-row]");
      expect(cards.length).toBe(RECIPES.length);
    });
  });

  it("filters cards by trigger chip", async () => {
    const { container, findByText } = render(<RecipesPage />);
    await waitFor(() => {
      expect(
        container.querySelectorAll(".recipes-gallery-card[data-recipe-row]").length,
      ).toBe(4);
    });

    // Click the "cron" trigger chip → only the two cron recipes remain.
    // Chip text is now the humanized filter phrase (triggerFilterLabel),
    // not the raw "cron" trigger-type string.
    const cronChip = await findByText(/^On a schedule \(2\)$/);
    fireEvent.click(cronChip);
    await waitFor(() => {
      const cards = container.querySelectorAll(".recipes-gallery-card[data-recipe-row]");
      expect(cards.length).toBe(2);
      expect(container.querySelector('[data-recipe-row="cron-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-recipe-row="hook-gamma"]')).toBeFalsy();
    });
  });

  it("filters cards by paused status chip", async () => {
    const { container, findByText } = render(<RecipesPage />);
    await waitFor(() => {
      expect(
        container.querySelectorAll(".recipes-gallery-card[data-recipe-row]").length,
      ).toBe(4);
    });

    const pausedChip = await findByText(/^paused \(1\)$/);
    fireEvent.click(pausedChip);
    await waitFor(() => {
      const cards = container.querySelectorAll(".recipes-gallery-card[data-recipe-row]");
      expect(cards.length).toBe(1);
      expect(container.querySelector('[data-recipe-row="manual-delta"]')).toBeTruthy();
    });
  });
});
