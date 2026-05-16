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
