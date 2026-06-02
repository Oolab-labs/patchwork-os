/**
 * Tests for DoctorPanel — the recipe-detail "Doctor" panel that calls
 * GET /api/bridge/recipes/doctor and renders the composed diagnosis.
 * Mocks fetch; asserts the verdict, static issues, and the runtime-halt
 * fix hints render.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoctorPanel, type DoctorResult } from "../_components/DoctorPanel";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HEALTHY: DoctorResult = {
  recipe: "demo",
  recipePath: "/x/demo.yaml",
  static: { ok: true, recipe: "demo", issues: [] },
  runtime: { total: 0, byCategory: {}, recent: [] },
  ok: true,
};

describe("DoctorPanel", () => {
  it("renders a healthy verdict with clean sections", async () => {
    mockFetchOnce(HEALTHY);
    render(<DoctorPanel recipeName="demo" />);
    fireEvent.click(screen.getByRole("button", { name: /run diagnosis/i }));
    await waitFor(() => expect(screen.getByText(/✓ healthy/)).toBeInTheDocument());
    expect(screen.getByText(/lint \+ policy clean/)).toBeInTheDocument();
    expect(screen.getByText(/none in the recent window/)).toBeInTheDocument();
  });

  it("renders runtime halts with the per-category fix hint", async () => {
    mockFetchOnce({
      recipe: "demo",
      recipePath: "/x/demo.yaml",
      static: { ok: true, recipe: "demo", issues: [] },
      runtime: {
        total: 2,
        byCategory: { auth_failure: 2 },
        recent: [
          { reason: "401 unauthorized", category: "auth_failure", runSeq: 9 },
        ],
      },
      ok: false,
    } satisfies DoctorResult);
    render(<DoctorPanel recipeName="demo" />);
    fireEvent.click(screen.getByRole("button", { name: /run diagnosis/i }));
    await waitFor(() =>
      expect(screen.getByText(/✗ needs attention/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/auth failure: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Reconnect from \/connections/)).toBeInTheDocument();
  });

  it("surfaces a recipe_not_found error", async () => {
    mockFetchOnce({ error: "recipe_not_found", message: "recipe x not found" }, false, 404);
    render(<DoctorPanel recipeName="x" />);
    fireEvent.click(screen.getByRole("button", { name: /run diagnosis/i }));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't run diagnosis/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/recipe x not found/)).toBeInTheDocument();
  });
});
