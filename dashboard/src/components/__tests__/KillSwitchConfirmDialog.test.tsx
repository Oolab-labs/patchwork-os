import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KillSwitchConfirmDialog } from "@/components/KillSwitchConfirmDialog";

describe("<KillSwitchConfirmDialog/>", () => {
  // Regression (diagnostic-report triage): the dialog previously claimed the
  // kill-switch "fans out to every connected bridge" — but the dashboard
  // proxy (dashboard/src/lib/bridge.ts's findBridge()) discovers and talks
  // to exactly ONE bridge, never a fan-out. Pinning the corrected,
  // single-bridge-scoped copy so this can't silently regress back to
  // overstating the scope.
  it("shows engage-specific copy scoped to this single bridge (not 'every connected bridge')", () => {
    render(<KillSwitchConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} direction="engage" />);
    expect(screen.getByText("Engage the kill-switch?")).toBeInTheDocument();
    expect(
      screen.getByText(/disables ALL writes on this bridge/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/every connected bridge/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Engage kill-switch" })).toBeInTheDocument();
  });

  it("shows release-specific copy scoped to this single bridge (not 'every connected bridge')", () => {
    render(<KillSwitchConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} direction="release" />);
    expect(screen.getByText("Release the kill-switch?")).toBeInTheDocument();
    expect(
      screen.getByText(/re-enables all writes on this bridge/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/every connected bridge/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release kill-switch" })).toBeInTheDocument();
  });

  it("Cancel closes without calling onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <KillSwitchConfirmDialog open onClose={onClose} onConfirm={onConfirm} direction="engage" />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Confirm calls onConfirm and onClose", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <KillSwitchConfirmDialog open onClose={onClose} onConfirm={onConfirm} direction="release" />,
    );
    await user.click(screen.getByRole("button", { name: "Release kill-switch" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is dismissible via Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <KillSwitchConfirmDialog open onClose={onClose} onConfirm={vi.fn()} direction="engage" />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    dialog.focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(<KillSwitchConfirmDialog open={false} onClose={vi.fn()} onConfirm={vi.fn()} direction="engage" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
