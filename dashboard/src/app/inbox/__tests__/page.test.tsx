import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Reproduce a failed/stalled Next dynamic chunk: the shell, metadata, and
// actions render, but the lazy markdown component never replaces its empty
// loading placeholder.
vi.mock("next/dynamic", () => ({
  default: (_loader: unknown, options?: { loading?: () => React.ReactNode }) =>
    function StalledDynamicImport() {
      return options?.loading?.() ?? null;
    },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/useBridgeFetch", () => ({
  useBridgeFetch: () => ({
    data: {
      items: [
        {
          name: "credit-review.md",
          path: "/tmp/credit-review.md",
          modifiedAt: "2026-07-29T10:00:00.000Z",
          preview: "Detailed credit review",
          provenance: { recipe: "credit-review", runSeq: 42 },
        },
      ],
    },
    error: undefined,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSearchHotkey", () => ({
  useSearchHotkey: () => ({ current: null }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/components/MessageMarkdown", () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

import InboxPage from "../page";

describe("Inbox message body", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "credit-review.md",
            modifiedAt: "2026-07-29T10:00:00.000Z",
            provenance: { recipe: "credit-review", runSeq: 42 },
            content: "## Recommendation\n\nApprove with a 1.2× DSCR covenant.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });

  it("renders fetched recipe markdown even when a dynamic chunk cannot load", async () => {
    render(<InboxPage />);

    // The surrounding reader proves this is the screenshot regression, not a
    // detail-fetch failure: metadata/actions are present while the body was blank.
    expect(await screen.findByText("Replay recipe")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText(/Approve with a 1\.2× DSCR covenant\./),
      ).toBeInTheDocument();
    });
  });
});
