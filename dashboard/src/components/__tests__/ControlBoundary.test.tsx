import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ControlBoundary, {
  type ActionBoundary,
} from "../ControlBoundary";

const boundary: ActionBoundary = {
  mayDoNow: [
    {
      label: "Read the ledger",
      toolName: "file_read",
      classKey: "fs-read:reversible:low",
      reason: "reversible (low blast) — undoable, flows un-gated",
    },
  ],
  needsApproval: [
    {
      label: "Publish the release",
      toolName: "npmPublish",
      classKey: "publish:irreversible:high",
      reason: "irreversible + unearned (effective L0 < L4) — gated for approval",
    },
  ],
  notPermitted: [
    {
      label: "Force-push to main",
      toolName: "gitPush",
      classKey: "vcs-push:compensable:high",
      reason: "forbidden by workspace policy (rule `vcs-push`): never from a worker",
    },
  ],
};

const empty: ActionBoundary = {
  mayDoNow: [],
  needsApproval: [],
  notPermitted: [],
};

describe("ControlBoundary", () => {
  it("renders all three columns with their headings", () => {
    render(<ControlBoundary boundary={boundary} />);
    expect(screen.getByText("May do now")).toBeInTheDocument();
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.getByText("Not permitted")).toBeInTheDocument();
  });

  it("distinguishes 'not permitted' from 'needs approval' in words, not only colour", () => {
    // The two columns are only meaningfully different if the third says no
    // approval unlocks it. Colour alone does not carry that, and does not
    // survive greyscale, a projector, or a colour-blind reader.
    render(<ControlBoundary boundary={boundary} />);
    expect(
      screen.getByText("No approval can unlock these"),
    ).toBeInTheDocument();
    expect(screen.getByText("A named person must say yes")).toBeInTheDocument();
  });

  it("puts each action in the column the bridge assigned it", () => {
    const { container } = render(<ControlBoundary boundary={boundary} />);
    const forbidden = container.querySelector(".cb-col--err");
    expect(forbidden).not.toBeNull();
    expect(
      within(forbidden as HTMLElement).getByText("Force-push to main"),
    ).toBeInTheDocument();
    // and NOT anywhere else
    const allowed = container.querySelector(".cb-col--ok") as HTMLElement;
    expect(
      within(allowed).queryByText("Force-push to main"),
    ).not.toBeInTheDocument();
  });

  it("shows the gate's own reason for each action", () => {
    render(<ControlBoundary boundary={boundary} />);
    expect(
      screen.getByText(/forbidden by workspace policy/),
    ).toBeInTheDocument();
    expect(screen.getByText(/undoable, flows un-gated/)).toBeInTheDocument();
  });

  it("says the boundary was computed before anything was attempted", () => {
    // The prospective claim IS the differentiator — a retrospective log of what
    // happened is something every tool has.
    render(<ControlBoundary boundary={boundary} />);
    expect(
      screen.getByText(/evaluated before anything was attempted/),
    ).toBeInTheDocument();
  });

  it("names the worker when given one", () => {
    render(<ControlBoundary boundary={boundary} workerName="Release Guardian" />);
    expect(
      screen.getByText(/What Release Guardian may do/),
    ).toBeInTheDocument();
  });

  it("renders empty columns with an explanation rather than a blank box", () => {
    render(<ControlBoundary boundary={empty} />);
    expect(
      screen.getByText("Nothing is forbidden for this worker."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 actions considered", { exact: false })).toBeInTheDocument();
  });

  it("singularises the count for one action", () => {
    render(
      <ControlBoundary
        boundary={{ ...empty, mayDoNow: boundary.mayDoNow }}
      />,
    );
    expect(screen.getByText(/1 action considered/)).toBeInTheDocument();
  });
});
