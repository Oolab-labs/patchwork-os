import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KillSwitchBanner } from "@/components/KillSwitchBanner";

describe("<KillSwitchBanner/> release confirm gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when not engaged", () => {
    render(<KillSwitchBanner engaged={false} locked={false} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clicking Release opens a confirm dialog and does not call the API yet", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<KillSwitchBanner engaged locked={false} />);

    await user.click(screen.getByRole("button", { name: /^Release/ }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Release the kill-switch?")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Cancel in the dialog does not call the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<KillSwitchBanner engaged locked={false} />);

    await user.click(screen.getByRole("button", { name: /^Release/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Confirm in the dialog calls POST /api/bridge/kill-switch with engage:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<KillSwitchBanner engaged locked={false} />);

    await user.click(screen.getByRole("button", { name: /^Release/ }));
    await user.click(screen.getByRole("button", { name: "Release kill-switch" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/bridge/kill-switch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ engage: false });
  });

  it("locked disables the Release button and never opens the dialog", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<KillSwitchBanner engaged locked />);

    const btn = screen.getByRole("button", { name: /^Release/ });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
