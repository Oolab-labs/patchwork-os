import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/recipes/sample-recipe/edit" }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    use: (value: Promise<{ name: string[] }> & { testValue?: { name: string[] } }) => value.testValue,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/hooks/useBridgeFetch", () => ({
  useBridgeFetch: () => ({
    data: [
      {
        name: "sample-recipe",
        description: "Reviews a private credit workbook.",
        enabled: true,
      },
    ],
  }),
}));

vi.mock("../_components/RailContext", () => ({ useRailData: () => null }));

import RecipeDetailLayout from "../layout";

describe("RecipeDetailLayout scroll behavior", () => {
  beforeEach(() => {
    mocks.pathname = "/recipes/sample-recipe/edit";
  });

  it("does not make the full-width recipe rail sticky above the editor", async () => {
    const params = Object.assign(Promise.resolve({ name: ["sample-recipe", "edit"] }), {
      testValue: { name: ["sample-recipe", "edit"] },
    });
    render(
      <RecipeDetailLayout params={params}>
        <div>Recipe editor</div>
      </RecipeDetailLayout>,
    );

    const rail = await screen.findByRole("complementary");
    expect(rail).toHaveClass("rd-rail-static");
    expect(screen.getByText("Recipe editor")).toBeInTheDocument();
  });
});
