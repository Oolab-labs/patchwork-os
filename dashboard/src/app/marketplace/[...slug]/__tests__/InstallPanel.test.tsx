/**
 * InstallPanel (single recipe, detail page) regression coverage.
 *
 * Focus: the gaps that the dogfood audit found on the detail page even
 * after PR #552 fixed them on the browse view —
 *   - three-state bridge status (401 vs 503/offline conflation)
 *   - install-confirm dialog gated by elevated risk metadata
 *   - Log-in CTA when unauth
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
import InstallPanel from "../InstallPanel";

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

const INSTALL = "github:patchworkos/recipes/recipes/morning-brief";
const NAME = "@patchworkos/morning-brief";

describe("InstallPanel — three-state bridge status", () => {
  it("shows the 'logged out' copy + Log in CTA when /api/bridge/recipes returns 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    render(<InstallPanel install={INSTALL} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/dashboard is logged out/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: /Log in/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Install$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the offline copy when /api/bridge/recipes returns 503", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    render(<InstallPanel install={INSTALL} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No local bridge detected/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("link", { name: /Log in/i }),
    ).not.toBeInTheDocument();
  });
});

describe("InstallPanel — install-confirm dialog", () => {
  it("installs in one tap when the recipe is low-risk (no confirm dialog)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] })) // status poll
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // install
    render(
      <InstallPanel
        install={INSTALL}
        name={NAME}
        riskLevel="low"
        networkAccess={false}
        fileAccess={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    // Install POST fires immediately, no dialog interception.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  // Regression: InstallPanel's elevated-confirm gate previously looked
  // ONLY at the registry's self-reported (unsigned, community-maintained)
  // risk_level/network_access/file_access — the reconciliation against the
  // recipe's actual YAML (detectTrustDivergence, in TrustDivergenceNotice)
  // rendered further down the same page but never fed back into this
  // gate. A recipe that claimed low-risk while its real YAML disagreed
  // still got a bare one-click Install button.
  it("opens the confirm dialog when hasTrustDivergence is true even though metadata claims low-risk", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] })); // status poll
    render(
      <InstallPanel
        install={INSTALL}
        name={NAME}
        riskLevel="low"
        networkAccess={false}
        fileAccess={false}
        hasTrustDivergence={true}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    // Dialog opens — install POST does NOT fire yet.
    await screen.findByRole("dialog");
    expect(fetchMock).toHaveBeenCalledTimes(1); // status poll only
  });

  it("still installs in one tap when hasTrustDivergence is false and metadata is low-risk", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] })) // status poll
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // install
    render(
      <InstallPanel
        install={INSTALL}
        name={NAME}
        riskLevel="low"
        networkAccess={false}
        fileAccess={false}
        hasTrustDivergence={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("opens the confirm dialog when trust metadata is missing (live-registry case)", async () => {
    // Marketplace trust Wave 0 — the live registry doesn't carry
    // risk_level / network_access / file_access on any recipe today.
    // The old gate ("show dialog only if elevated === true") would
    // silent-install every live recipe. The new gate requires the
    // recipe to EXPLICITLY claim {risk: low, networkAccess: false,
    // fileAccess: false} to bypass — missing fields fail closed.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] }));
    render(<InstallPanel install={INSTALL} name={NAME} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    // Dialog opens — install POST does NOT fire yet.
    await screen.findByRole("dialog");
    expect(fetchMock).toHaveBeenCalledTimes(1); // status poll only
  });

  it("opens the confirm dialog before installing a high-risk recipe", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] })) // status poll
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // install
    render(
      <InstallPanel
        install={INSTALL}
        name={NAME}
        riskLevel="high"
        connectors={["gmail", "slack"]}
        networkAccess
        fileAccess
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));

    // Dialog has rendered, install POST NOT yet sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("dialog", {
        name: /Confirm install of morning-brief/i,
      }),
    ).toBeInTheDocument();
    // Risk + connectors + network/file bullets visible.
    expect(screen.getByText(/Risk:/i)).toBeInTheDocument();
    expect(screen.getByText(/gmail, slack/i)).toBeInTheDocument();
    expect(screen.getByText(/Network access/i)).toBeInTheDocument();
    expect(screen.getByText(/File access/i)).toBeInTheDocument();

    // Confirm fires the POST.
    const confirms = screen.getAllByRole("button", { name: /^Install$/i });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("surfaces a missing-connectors notice when the bridge install response includes one", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { recipes: [] })) // status poll
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          missingConnectors: ["gmail", "slack", "google-calendar"],
        }),
      );
    render(
      <InstallPanel
        install={INSTALL}
        name={NAME}
        riskLevel="low"
        networkAccess={false}
        fileAccess={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Connect these services/i);
    // Wave 1: per-connector deep-links replace the single "Open
    // connections" button. Each link reads "Connect <Label> →" and
    // points at `/connections#<connector-id>` for direct landing.
    expect(
      screen.getByRole("link", { name: /Connect Gmail/i }),
    ).toHaveAttribute("href", "/connections#gmail");
    expect(
      screen.getByRole("link", { name: /Connect Slack/i }),
    ).toHaveAttribute("href", "/connections#slack");
    expect(
      screen.getByRole("link", { name: /Connect Google Calendar/i }),
    ).toHaveAttribute("href", "/connections#google-calendar");
  });

  it("Cancel button in the dialog does not POST", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { recipes: [] }));
    render(
      <InstallPanel
        install={INSTALL}
        name={NAME}
        riskLevel="high"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Install$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel/i }));
    // Only the status-poll call; no install POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
