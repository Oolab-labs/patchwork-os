/**
 * BundleInstallPanel — install-button + partial-success rendering tests
 * (#130 PR B).
 *
 * Mocks `fetch` to control bridge responses; verifies:
 *   - status polling renders the right copy depending on bridge state
 *   - clicking "Install bundle" POSTs to /api/bridge/recipes/install
 *     with the exact source from the registry
 *   - partial-success response renders both installed[] and failures[]
 *   - plugin / policy_template advisory props render manual-followup copy
 *
 * Pattern: vitest + RTL + jsdom, same setup as the rest of dashboard tests.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import BundleInstallPanel from "../BundleInstallPanel";

let fetchMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SOURCE = "github:patchworkos/recipes/bundles/morning";
const RECIPES = ["a-recipe", "b-recipe", "c-recipe"];
const NAME = "morning";

describe("BundleInstallPanel — status polling", () => {
  it("shows 'Bridge connected' copy when none of the bundle's recipes are installed", async () => {
    // First (and only) call fetches /api/bridge/recipes; return empty.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] }));
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Bridge connected — install all 3 recipes/i),
      ).toBeInTheDocument(),
    );
    // Install button rendered when bridge is online + nothing installed.
    expect(
      screen.getByRole("button", { name: /Install bundle/i }),
    ).toBeInTheDocument();
  });

  it("counts scoped manifest entries as installed when bridge returns unscoped names (regression)", async () => {
    // Regression: bundle manifests may declare recipes as scoped names
    // ("@patchworkos/morning-brief") but the bridge writes them under the
    // unscoped YAML `name:` ("morning-brief"). Without shortName() the
    // installed-count was always 0 for scoped bundles.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { recipes: [{ name: "a-recipe" }, { name: "b-recipe" }] }),
    );
    render(
      <BundleInstallPanel
        installSource={SOURCE}
        recipes={["@patchworkos/a-recipe", "@patchworkos/b-recipe", "@patchworkos/c-recipe"]}
        name={NAME}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/2 of 3 recipes already installed/i),
      ).toBeInTheDocument(),
    );
  });

  it("shows partial-installed copy when some recipes already exist", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { recipes: [{ name: "a-recipe" }] }),
    );
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/1 of 3 recipes already installed/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Install bundle/i }),
    ).toBeInTheDocument();
  });

  it("hides install button + shows ✓ copy when all recipes are installed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recipes: RECIPES.map((name) => ({ name })),
      }),
    );
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/All 3 recipes installed locally/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Install bundle/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to 'No local bridge' copy when /api/bridge/recipes errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No local bridge detected/i),
      ).toBeInTheDocument(),
    );
    // No install button when bridge is offline — only the CLI copy box.
    expect(
      screen.queryByRole("button", { name: /Install bundle/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the 'logged out' copy + Log in CTA when /api/bridge/recipes returns 401", async () => {
    // Three-state bridge status: 401 must NOT be conflated with 503/offline.
    // Pre-fix the bundle panel said "No local bridge detected" when the
    // dashboard was logged out, even though the bridge was reachable.
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/dashboard is logged out/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: /Log in/i }),
    ).toBeInTheDocument();
    // Install button is hidden in the unauth state — the Log-in CTA takes
    // its slot.
    expect(
      screen.queryByRole("button", { name: /Install bundle/i }),
    ).not.toBeInTheDocument();
  });
});

describe("BundleInstallPanel — install action", () => {
  it("POSTs the installSource verbatim and renders the installed[] result", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] })) // status poll
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          kind: "bundle",
          bundleName: "morning",
          installed: [
            { name: "a-recipe", action: "created" },
            { name: "b-recipe", action: "created" },
            { name: "c-recipe", action: "created" },
          ],
          failures: [],
        }),
      );
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Install bundle/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Install bundle/i }));
    // Confirm dialog opens; click the confirm button inside it.
    const confirmBtns = screen.getAllByRole("button", { name: /Install bundle/i });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() =>
      expect(screen.getByText(/Installed 3 recipes:/i)).toBeInTheDocument(),
    );

    // Verify the install POST went to the right URL with the exact source.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/bridge/recipes/install");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { source: string };
    expect(body.source).toBe(SOURCE);
  });

  it("renders both installed[] and failures[] for partial success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          kind: "bundle",
          installed: [{ name: "a-recipe", action: "created" }],
          failures: [
            { name: "b-recipe", error: "Upstream returned 404" },
            { name: "c-recipe", error: "Recipe body exceeded 1 MB cap" },
          ],
        }),
      );
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Install bundle/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Install bundle/i }));
    // Confirm dialog opens; click the confirm button inside it.
    const confirmBtns = screen.getAllByRole("button", { name: /Install bundle/i });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() => expect(screen.getByText(/2 failed:/i)).toBeInTheDocument());
    expect(screen.getByText(/Installed 1 recipe:/i)).toBeInTheDocument();
    expect(screen.getByText(/Upstream returned 404/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Recipe body exceeded 1 MB cap/i),
    ).toBeInTheDocument();
  });

  it("surfaces an error banner when bridge returns 502 with no installed[]", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] }))
      .mockResolvedValueOnce(
        jsonResponse(400, {
          ok: false,
          error: "Bundle manifest must declare a non-empty `recipes` array",
          code: "bundle_manifest_invalid_recipes",
        }),
      );
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Install bundle/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Install bundle/i }));
    // Confirm dialog opens; click the confirm button inside it.
    const confirmBtns = screen.getAllByRole("button", { name: /Install bundle/i });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() =>
      expect(
        screen.getByRole("alert"),
      ).toHaveTextContent(/non-empty .recipes. array/i),
    );
  });

  it("surfaces a missing-connectors notice when bundle install response includes one", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          kind: "bundle",
          installed: [{ name: "a-recipe", action: "created" }],
          failures: [],
          missingConnectors: ["gmail", "linear"],
        }),
      );
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Install bundle/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Install bundle/i }));
    // Confirm dialog opens; click the confirm button inside it.
    const confirmBtns = screen.getAllByRole("button", { name: /Install bundle/i });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Connect these services/i);
    expect(alert).toHaveTextContent(/Gmail/);
    expect(alert).toHaveTextContent(/Linear/);
    expect(
      screen.getByRole("link", { name: /Open connections/i }),
    ).toHaveAttribute("href", "/connections");
  });
});

describe("BundleInstallPanel — advisory rendering", () => {
  it("renders plugin advisory when manifest declares one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] }));
    render(
      <BundleInstallPanel
        installSource={SOURCE}
        recipes={RECIPES}
        name={NAME}
        plugin="@example/plugin"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Manual follow-up needed/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Plugin/),
    ).toBeInTheDocument();
    expect(screen.getByText("@example/plugin")).toBeInTheDocument();
  });

  it("renders policy template advisory when manifest declares one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] }));
    render(
      <BundleInstallPanel
        installSource={SOURCE}
        recipes={RECIPES}
        name={NAME}
        policyTemplate="policies/strict.json"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Manual follow-up needed/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Policy template/),
    ).toBeInTheDocument();
    expect(screen.getByText("policies/strict.json")).toBeInTheDocument();
  });

  it("does not render the manual-followup section when no advisory is present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] }));
    render(<BundleInstallPanel installSource={SOURCE} recipes={RECIPES} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Install bundle/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Manual follow-up needed/i),
    ).not.toBeInTheDocument();
  });
});
