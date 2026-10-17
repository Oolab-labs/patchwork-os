/**
 * A failed request is not an answer (audit M31). DecisionReceipt never
 * checked `res.ok`: a 401/500/502 body has no `explanation`, so it rendered
 * "No gate decision has been recorded for this worker yet" — a definite
 * claim made from a request that failed.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionReceipt } from "../DecisionReceipt";

afterEach(() => vi.unstubAllGlobals());

describe("DecisionReceipt on a failed request", () => {
  it("says it could not read the record, never that nothing was decided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "upstream" }), { status: 502 })),
    );
    render(<DecisionReceipt workerId="worker-0001" />);
    await waitFor(() => expect(screen.getByText(/Could not read the decision record/)).toBeTruthy());
    expect(screen.queryByText(/No gate decision has been recorded/)).toBeNull();
    expect(screen.getByText(/502/)).toBeTruthy();
  });
});
