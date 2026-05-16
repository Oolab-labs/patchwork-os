/**
 * Component tests for the marketplace "Submit a recipe" page.
 *
 * Pattern: vitest + RTL + jsdom, same as BundleInstallPanel.test.tsx.
 *
 * What we mock:
 *  - `next/dynamic` so the CodeMirror-backed YamlEditor resolves to a
 *    plain <textarea> we can drive from the test.
 *  - `fetch` for the initial /api/bridge/recipes load (controls
 *    bridgeOnline + installedNames) AND the lint POST.
 *  - `window.open` to assert the URL handoff without actually opening
 *    a popup.
 *  - `navigator.clipboard` so the CopyableBlock tests don't throw on
 *    jsdom's missing clipboard API.
 *
 * What we don't mock:
 *  - The marketplaceSubmit utility (already covered by its own unit
 *    test suite — let it run for end-to-end behavior).
 *  - The Toast provider — `useToast` returns no-op stubs when no
 *    provider is mounted, which is the right behavior for tests.
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
import MarketplaceSubmitPage from "../page";

// --- mocks ----------------------------------------------------------

// Replace the dynamic CodeMirror editor with a plain textarea so RTL can
// drive its value. The real one touches `document` on mount and is loaded
// via next/dynamic — both fragile under jsdom.
vi.mock("next/dynamic", () => ({
  default: () => {
    return function FakeYamlEditor(props: {
      value: string;
      onChange: (v: string) => void;
    }) {
      return (
        <textarea
          data-testid="fake-yaml-editor"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    };
  },
}));

let fetchMock: Mock;
let openMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  openMock = vi.fn().mockReturnValue({} as Window);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("open", openMock);
  // jsdom doesn't implement navigator.clipboard — stub it so CopyableBlock
  // doesn't throw if a test ever reaches it.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  // Drop any draft a previous test wrote — the page restores from
  // sessionStorage on mount and we want each test to start from a clean
  // form.
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- fill helpers ---------------------------------------------------

async function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/Slug/i), {
    target: { value: "my-recipe" },
  });
  fireEvent.change(screen.getByLabelText(/Author handle/i), {
    target: { value: "myhandle" },
  });
  fireEvent.change(screen.getByLabelText(/Description/i), {
    target: { value: "A test recipe." },
  });
  fireEvent.change(screen.getByLabelText(/^Tags/i), {
    target: { value: "test, hello" },
  });
}

/**
 * Submit guard requires that Validate has been clicked at least once
 * before the GitHub tab is opened — either a fresh successful lint or a
 * recorded bridge-unreachable lintError counts. Most submit-flow tests
 * mock fetch as all-503, so clicking Validate produces the unreachable
 * branch which is sufficient. Helper consolidates the dance.
 */
async function runValidateAndWait() {
  fireEvent.click(screen.getByRole("button", { name: /^Validate$/i }));
  // Wait for the bridge-unreachable copy or the success badge to settle.
  await waitFor(() =>
    expect(
      screen
        .queryByText(/Lint passed/i)
        // Bridge-unreachable text comes from the lint route.ts error path.
        ?? screen.queryByText(/Bridge isn't responding/i)
        ?? screen.queryByText(/Validation request failed/i),
    ).not.toBeNull(),
  );
}

// =====================================================================
// Validation
// =====================================================================

describe("MarketplaceSubmitPage — validation", () => {
  beforeEach(() => {
    // Initial /api/bridge/recipes call fails (bridge offline) — we don't
    // need installed-recipe dropdown for these tests.
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
  });

  it("renders field-level errors when submitted empty", async () => {
    render(<MarketplaceSubmitPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open PR on GitHub/i }),
    );

    expect(await screen.findByText(/Slug must start with/i)).toBeInTheDocument();
    expect(screen.getByText(/Author handle must follow/i)).toBeInTheDocument();
    expect(screen.getByText(/Description is required/i)).toBeInTheDocument();
    expect(screen.getByText(/At least one tag is required/i)).toBeInTheDocument();

    // No GitHub tab opened.
    expect(openMock).not.toHaveBeenCalled();
  });

  it("shows a normalization warning when the slug input contains unicode/uppercase", async () => {
    render(<MarketplaceSubmitPage />);
    fireEvent.change(screen.getByLabelText(/^Slug/i), {
      target: { value: "Café Daily" },
    });
    expect(
      await screen.findByText(
        /Will be saved as ["“]caf-daily["”] — only lowercase letters, digits, and hyphens are allowed\./i,
      ),
    ).toBeInTheDocument();
  });

  it("blocks submit when YAML name doesn't match the slug", async () => {
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();
    fireEvent.change(screen.getByTestId("fake-yaml-editor"), {
      target: { value: "name: completely-different-name\n" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Open PR on GitHub/i }));

    expect(
      await screen.findByText(
        /YAML "name: completely-different-name" doesn't match the slug/i,
      ),
    ).toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Lint button
// =====================================================================

describe("MarketplaceSubmitPage — lint button", () => {
  it("POSTs YAML to /api/bridge/recipes/lint and renders errors", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, {})) // initial recipes load
      .mockResolvedValueOnce(
        jsonResponse(200, {
          errors: ["trigger.type is required"],
          warnings: ["consider adding a description"],
        }),
      );

    render(<MarketplaceSubmitPage />);
    fireEvent.change(screen.getByTestId("fake-yaml-editor"), {
      target: { value: "name: test\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Validate$/i }));

    expect(
      await screen.findByText(/trigger\.type is required/i),
    ).toBeInTheDocument();

    // Verify the POST shape — second call (after initial recipes load).
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/api/bridge/recipes/lint");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain("name: test");
  });

  it("surfaces a bridge-offline message on 503", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, {})) // initial recipes load
      .mockResolvedValueOnce(jsonResponse(503, {})); // lint call

    render(<MarketplaceSubmitPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Validate$/i }));

    expect(
      await screen.findByText(/Bridge isn't responding/i),
    ).toBeInTheDocument();
  });
});

// =====================================================================
// Submit + manifest handoff
// =====================================================================

describe("MarketplaceSubmitPage — submit flow", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
  });

  it("opens a GitHub create-file URL with the recipe.yaml prefilled", async () => {
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();
    await runValidateAndWait();

    fireEvent.click(screen.getByRole("button", { name: /Open PR on GitHub/i }));

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    const [url, target, features] = openMock.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(url).toMatch(
      /^https:\/\/github\.com\/patchworkos\/recipes\/new\/main\?/,
    );
    expect(decodeURIComponent(url)).toContain(
      "filename=recipes/my-recipe/recipe.yaml",
    );
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");

    // Transitioned to "submitted" view.
    expect(
      await screen.findByRole("heading", {
        name: /Recipe submission in progress/i,
      }),
    ).toBeInTheDocument();
  });

  it("opens a second GitHub tab with recipe.json when manifest button is clicked", async () => {
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();
    await runValidateAndWait();
    fireEvent.click(screen.getByRole("button", { name: /Open PR on GitHub/i }));

    // wait for transition
    await screen.findByRole("button", {
      name: /Open recipe\.json on GitHub/i,
    });

    openMock.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: /Open recipe\.json on GitHub/i }),
    );

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    const [manifestUrl] = openMock.mock.calls[0] as [string];
    expect(decodeURIComponent(manifestUrl)).toContain(
      "filename=recipes/my-recipe/recipe.json",
    );
    expect(decodeURIComponent(manifestUrl)).toContain("@myhandle/my-recipe");
  });

  it("returns to compose view when Start over is clicked", async () => {
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();
    await runValidateAndWait();
    fireEvent.click(screen.getByRole("button", { name: /Open PR on GitHub/i }));
    await screen.findByRole("heading", {
      name: /Recipe submission in progress/i,
    });

    fireEvent.click(screen.getByRole("button", { name: /Start over/i }));

    expect(
      await screen.findByRole("heading", { name: /^Submit a recipe$/i }),
    ).toBeInTheDocument();
  });
});

// =====================================================================
// Lint-pass badge (persistent indicator)
// =====================================================================

describe("MarketplaceSubmitPage — lint-pass badge", () => {
  it("renders a persistent 'Lint passed' badge for content that was just validated", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, {})) // initial recipes load
      .mockResolvedValueOnce(jsonResponse(200, { errors: [], warnings: [] }));

    render(<MarketplaceSubmitPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Validate$/i }));

    expect(await screen.findByText(/Lint passed/i)).toBeInTheDocument();
  });

  it("replaces the badge with a 'YAML edited' note when the YAML changes after lint", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { errors: [], warnings: [] }));

    render(<MarketplaceSubmitPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Validate$/i }));
    await screen.findByText(/Lint passed/i);

    // Edit the YAML — badge should disappear, stale note should appear.
    fireEvent.change(screen.getByTestId("fake-yaml-editor"), {
      target: { value: "name: my-recipe\n# edited\n" },
    });

    expect(screen.queryByText(/Lint passed/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/YAML edited since last validation/i),
    ).toBeInTheDocument();
  });
});

// =====================================================================
// sessionStorage draft restore
// =====================================================================

describe("MarketplaceSubmitPage — sessionStorage draft", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
  });

  it("restores form state from sessionStorage on mount", async () => {
    sessionStorage.setItem(
      "patchwork.marketplaceSubmit.draft.v1",
      JSON.stringify({
        slugRaw: "restored-slug",
        authorRaw: "restored-author",
        version: "2.1.0",
        description: "Restored description.",
        tagsInput: "restored",
        connectorsInput: "",
        license: "Apache-2.0",
        homepage: "",
        riskLevel: "medium",
        networkAccess: true,
        fileAccess: false,
        approvalBehavior: "always_ask",
        yaml: "name: restored-slug\n",
      }),
    );

    render(<MarketplaceSubmitPage />);

    expect(
      (screen.getByLabelText(/^Slug/i) as HTMLInputElement).value,
    ).toBe("restored-slug");
    expect(
      (screen.getByLabelText(/Author handle/i) as HTMLInputElement).value,
    ).toBe("restored-author");
    expect(
      (screen.getByLabelText(/Version/i) as HTMLInputElement).value,
    ).toBe("2.1.0");
    expect(
      (screen.getByLabelText(/Description/i) as HTMLTextAreaElement).value,
    ).toBe("Restored description.");
  });

  it("restores 'submitted' stage from sessionStorage (regression — refresh after submit must stay on success view)", () => {
    // Reproduces dogfood Bug #5: user clicked Submit (which transitioned
    // to the success view with the "Open recipe.json on GitHub" button),
    // then refreshed the page. Pre-fix the user landed back on compose
    // view with the draft restored — losing access to the second-file
    // button, and a Submit-again would open a duplicate prefilled tab.
    sessionStorage.setItem(
      "patchwork.marketplaceSubmit.draft.v1",
      JSON.stringify({
        slugRaw: "my-recipe",
        authorRaw: "myhandle",
        version: "1.0.0",
        description: "test",
        tagsInput: "test",
        connectorsInput: "",
        license: "MIT",
        homepage: "",
        riskLevel: "low",
        networkAccess: false,
        fileAccess: false,
        approvalBehavior: "ask_on_novel",
        yaml: "name: my-recipe\n",
        stage: "submitted",
      }),
    );

    render(<MarketplaceSubmitPage />);

    expect(
      screen.getByRole("heading", { name: /Recipe submission in progress/i }),
    ).toBeInTheDocument();
    // The second-step button must be reachable.
    expect(
      screen.getByRole("button", { name: /Open recipe\.json on GitHub/i }),
    ).toBeInTheDocument();
  });

  it("defaults stage to 'compose' when the persisted draft omits it (older drafts)", () => {
    // Drafts saved before the stage field shipped won't have it.
    // Don't accidentally land users on a never-submitted "submitted"
    // view.
    sessionStorage.setItem(
      "patchwork.marketplaceSubmit.draft.v1",
      JSON.stringify({
        slugRaw: "from-v1",
        authorRaw: "",
        version: "1.0.0",
        description: "",
        tagsInput: "",
        connectorsInput: "",
        license: "MIT",
        homepage: "",
        riskLevel: "low",
        networkAccess: false,
        fileAccess: false,
        approvalBehavior: "ask_on_novel",
        yaml: "name: from-v1\n",
        // intentionally no `stage`
      }),
    );

    render(<MarketplaceSubmitPage />);

    expect(
      screen.getByRole("heading", { name: /^Submit a recipe$/i }),
    ).toBeInTheDocument();
  });

  it("falls back to defaults when sessionStorage contains malformed data", () => {
    sessionStorage.setItem(
      "patchwork.marketplaceSubmit.draft.v1",
      "{ not valid json",
    );

    render(<MarketplaceSubmitPage />);

    // Reaching this assertion means the page mounted without throwing on
    // bad JSON. The fields fall back to their defaults.
    expect(
      (screen.getByLabelText(/Version/i) as HTMLInputElement).value,
    ).toBe("1.0.0");
  });

  it("clears the draft when Start over is clicked", async () => {
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();
    await runValidateAndWait();
    fireEvent.click(screen.getByRole("button", { name: /Open PR on GitHub/i }));
    await screen.findByRole("heading", {
      name: /Recipe submission in progress/i,
    });

    // Auto-save fired before submit — confirm there IS something in storage.
    expect(
      sessionStorage.getItem("patchwork.marketplaceSubmit.draft.v1"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Start over/i }));

    expect(
      sessionStorage.getItem("patchwork.marketplaceSubmit.draft.v1"),
    ).toBeNull();
  });
});

// =====================================================================
// Preset picker
// =====================================================================

describe("MarketplaceSubmitPage — preset picker", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
  });

  it("swaps the YAML editor content when a preset is selected", async () => {
    render(<MarketplaceSubmitPage />);
    const editor = screen.getByTestId("fake-yaml-editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("type: manual");

    fireEvent.change(
      screen.getByLabelText(/Load a starter recipe preset/i),
      { target: { value: "scheduled" } },
    );

    expect(
      (screen.getByTestId("fake-yaml-editor") as HTMLTextAreaElement).value,
    ).toContain("type: cron");
  });

  it("offers all three presets", () => {
    render(<MarketplaceSubmitPage />);
    const picker = screen.getByLabelText(/Load a starter recipe preset/i);
    const optionValues = Array.from(
      picker.querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    // First entry is the empty placeholder.
    expect(optionValues).toEqual(["", "manual", "scheduled", "webhook"]);
  });

  it("prompts before overwriting YAML the user has customized", async () => {
    render(<MarketplaceSubmitPage />);
    // Customize the YAML so the guard fires.
    fireEvent.change(screen.getByTestId("fake-yaml-editor"), {
      target: { value: "name: hand-edited\n# user's work\n" },
    });

    fireEvent.change(
      screen.getByLabelText(/Load a starter recipe preset/i),
      { target: { value: "webhook" } },
    );

    // Dialog opens with the "Replace YAML?" prompt — the editor still
    // holds the customized content.
    expect(
      await screen.findByRole("dialog", {
        name: /Confirm overwrite of in-progress recipe YAML/i,
      }),
    ).toBeInTheDocument();
    expect(
      (screen.getByTestId("fake-yaml-editor") as HTMLTextAreaElement).value,
    ).toContain("hand-edited");

    fireEvent.click(screen.getByRole("button", { name: /Keep my YAML/i }));
    // After cancel, the editor still holds the user's work.
    expect(
      (screen.getByTestId("fake-yaml-editor") as HTMLTextAreaElement).value,
    ).toContain("hand-edited");
  });

  it("swaps YAML without prompting when editor matches the starter recipe", async () => {
    render(<MarketplaceSubmitPage />);
    fireEvent.change(
      screen.getByLabelText(/Load a starter recipe preset/i),
      { target: { value: "webhook" } },
    );
    // No dialog — swap happens directly.
    expect(
      screen.queryByRole("dialog", {
        name: /Confirm overwrite/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      (screen.getByTestId("fake-yaml-editor") as HTMLTextAreaElement).value,
    ).toContain("type: webhook");
  });
});

// =====================================================================
// Validate-before-submit guard
// =====================================================================

describe("MarketplaceSubmitPage — Validate-before-submit guard", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
  });

  it("blocks submit and surfaces an inline error when Validate has not been clicked", async () => {
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();
    // Skip the runValidateAndWait() helper — that's the user mistake the
    // guard is meant to catch.
    fireEvent.click(screen.getByRole("button", { name: /Open PR on GitHub/i }));

    expect(
      await screen.findByText(/Click Validate first/i),
    ).toBeInTheDocument();
    // GitHub tab was NOT opened.
    expect(openMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Draft-restored banner
// =====================================================================

describe("MarketplaceSubmitPage — draft-restored banner", () => {
  it("shows the banner when a draft was restored from sessionStorage", () => {
    sessionStorage.setItem(
      "patchwork.marketplaceSubmit.draft.v1",
      JSON.stringify({
        slugRaw: "restored",
        authorRaw: "",
        version: "1.0.0",
        description: "",
        tagsInput: "",
        connectorsInput: "",
        license: "MIT",
        homepage: "",
        riskLevel: "low",
        networkAccess: false,
        fileAccess: false,
        approvalBehavior: "ask_on_novel",
        yaml: "name: restored\n",
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse(503, {}));

    render(<MarketplaceSubmitPage />);

    expect(screen.getByText(/Draft restored\./i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Discard and start fresh/i }),
    ).toBeInTheDocument();
  });

  it("does NOT show the banner on a clean first visit", () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    render(<MarketplaceSubmitPage />);
    expect(screen.queryByText(/Draft restored\./i)).not.toBeInTheDocument();
  });

  it("'Discard and start fresh' clears all fields and dismisses the banner", async () => {
    sessionStorage.setItem(
      "patchwork.marketplaceSubmit.draft.v1",
      JSON.stringify({
        slugRaw: "to-discard",
        authorRaw: "ghost",
        version: "1.0.0",
        description: "Stale.",
        tagsInput: "old",
        connectorsInput: "",
        license: "MIT",
        homepage: "",
        riskLevel: "low",
        networkAccess: false,
        fileAccess: false,
        approvalBehavior: "ask_on_novel",
        yaml: "name: to-discard\n",
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse(503, {}));

    render(<MarketplaceSubmitPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /Discard and start fresh/i }),
    );

    expect(screen.queryByText(/Draft restored\./i)).not.toBeInTheDocument();
    expect(
      (screen.getByLabelText(/^Slug/i) as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText(/Author handle/i) as HTMLInputElement).value,
    ).toBe("");
    expect(
      sessionStorage.getItem("patchwork.marketplaceSubmit.draft.v1"),
    ).toBeNull();
  });
});

// =====================================================================
// Inline manifest preview
// =====================================================================

describe("MarketplaceSubmitPage — manifest preview", () => {
  it("renders a <details> with the generated recipe.json content", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    render(<MarketplaceSubmitPage />);
    await fillRequiredFields();

    // Forces React to flush form-state updates before we read the preview.
    const summary = screen.getByText(
      /Preview .* the manifest that will be committed/i,
    );
    expect(summary).toBeInTheDocument();

    // Reach the <pre> sibling within the <details>; the content reflects
    // formData (the scoped name should appear).
    const details = summary.closest("details");
    expect(details?.querySelector("pre")?.textContent).toContain(
      "@myhandle/my-recipe",
    );
  });
});

// =====================================================================
// Bridge-online: load installed recipes dropdown
// =====================================================================

describe("MarketplaceSubmitPage — bridge online", () => {
  it("shows the 'start from installed recipe' dropdown when bridge is online", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recipes: [{ name: "morning-brief" }, { name: "deal-won" }],
      }),
    );

    render(<MarketplaceSubmitPage />);

    expect(
      await screen.findByLabelText(
        /Load an installed recipe as a starting point/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "morning-brief" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "deal-won" })).toBeInTheDocument();
  });

  it("hides the dropdown when bridge fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    render(<MarketplaceSubmitPage />);

    // Give the effect a tick to settle.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByLabelText(
        /Load an installed recipe as a starting point/i,
      ),
    ).not.toBeInTheDocument();
  });
});
