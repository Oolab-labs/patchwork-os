/**
 * Regression test for the "Cancel button doesn't work" bug on the
 * Disconnect-Slack confirmation modal.
 *
 * Cause: <Dialog> sets the `inert` attribute on `[data-app-root]` while open
 * to mark the rest of the app non-interactive. The dialog itself is rendered
 * inline in the React tree, so before the portal fix it lived as a *descendant*
 * of `[data-app-root]` — making the dialog (and its Cancel/Confirm buttons)
 * inert too. Clicking Cancel did nothing.
 *
 * Fix: render the dialog through a portal into `document.body`, escaping the
 * inert subtree.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog } from "@/components/Dialog";

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <div data-app-root>
      <main>app shell content</main>
      <Dialog open={open} onClose={() => setOpen(false)} ariaLabel="confirm">
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </Dialog>
    </div>
  );
}

describe("<Dialog/> escapes the inert app root", () => {
  it("renders the dialog panel outside [data-app-root]", () => {
    render(<Harness />);
    const panel = screen.getByRole("dialog");
    // Before the fix, panel.closest('[data-app-root]') resolves to the wrapper
    // div — the dialog is a descendant of the inert subtree and its buttons
    // can't be clicked. After the fix (createPortal to document.body) the
    // closest data-app-root ancestor is null.
    expect(panel.closest("[data-app-root]")).toBeNull();
  });

  it("Cancel click closes the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
