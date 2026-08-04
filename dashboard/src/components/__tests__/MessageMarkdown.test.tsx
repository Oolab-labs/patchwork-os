import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MessageMarkdown from "../MessageMarkdown";

describe("MessageMarkdown", () => {
  it("hides recipe provenance frontmatter while rendering the report body", () => {
    render(
      <MessageMarkdown
        content={`---
recipe: sample-recipe
runSeq: 11800
trigger: manual
deliveredAt: 2026-07-29T14:00:00.000Z
---

# Private Credit Review

Approve with conditions.`}
        components={{}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Private Credit Review" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Approve with conditions.")).toBeInTheDocument();
    expect(
      screen.queryByText(/recipe: sample-recipe/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/runSeq: 11800/)).not.toBeInTheDocument();
  });
});
