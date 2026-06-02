import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type JudgeVerdict,
  JudgeVerdictPill,
} from "../_components/JudgeVerdictPill";

describe("JudgeVerdictPill", () => {
  it("renders the verdict label and first reason", () => {
    const verdict: JudgeVerdict = {
      verdict: "request_changes",
      reasons: ["Missing unit tests for the refactor", "Naming is inconsistent"],
    };
    render(<JudgeVerdictPill verdict={verdict} />);
    expect(screen.getByText(/judge: request_changes/)).toBeInTheDocument();
    expect(
      screen.getByText(/Missing unit tests for the refactor/),
    ).toBeInTheDocument();
    // second reason collapsed into a "+N more" affordance
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
  });

  it("renders the judge's suggested fixes when fixList is present", () => {
    const verdict: JudgeVerdict = {
      verdict: "request_changes",
      reasons: ["Missing unit tests"],
      fixList: [
        "Add a vitest spec covering the error path",
        "Re-run preflight after editing",
      ],
    };
    render(<JudgeVerdictPill verdict={verdict} />);
    expect(screen.getByText(/suggested fixes/)).toBeInTheDocument();
    expect(
      screen.getByText(/Add a vitest spec covering the error path/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Re-run preflight after editing/),
    ).toBeInTheDocument();
  });

  it("omits the suggested-fixes block when fixList is empty or blank", () => {
    const verdict: JudgeVerdict = {
      verdict: "approve",
      reasons: ["Looks good"],
      fixList: ["   "],
    };
    render(<JudgeVerdictPill verdict={verdict} />);
    expect(screen.queryByText(/suggested fixes/)).not.toBeInTheDocument();
  });
});
