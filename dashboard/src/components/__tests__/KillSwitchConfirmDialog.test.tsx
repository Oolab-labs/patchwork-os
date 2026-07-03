import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KillSwitchConfirmDialog } from "@/components/KillSwitchConfirmDialog";

describe("<KillSwitchConfirmDialog/>", () => {
  it("shows engage-specific copy", () => {
    render(<KillSwitchConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} direction="engage" />);
    expect(screen.getByText("Engage the kill-switch?")).toBeInTheDocument();
    expect(
      screen.getByText(/disables ALL writes across every connected bridge/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Engage kill-switch" })).toBeInTheDocument();
  });

  it("shows release-specific copy", () => {
    render(<KillSwitchConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} direction="release" />);
    expect(screen.getByText("Release the kill-switch?")).toBeInTheDocument();
    expect(
      screen.getByText(/re-enables all writes across every connected bridge/i),
    ).toBeInTheDocument();
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
