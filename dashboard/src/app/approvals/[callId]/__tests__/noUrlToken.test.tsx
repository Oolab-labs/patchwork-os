/**
 * The approval detail page must not take a credential from the URL
 * (audit M32). It read `?approvalToken=` and sent it as a Bearer header —
 * which the bridge proxy drops (it substitutes its own token), so the
 * feature never worked, while the token sat in browser history and logs.
 * Nothing generates such links any more: push notifications carry the
 * token in the notification payload and send it as a header.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replaceState = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ callId: "call-0001" }),
  useSearchParams: () => new URLSearchParams("approvalToken=tok-placeholder"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/approvals/call-0001",
}));
vi.mock("@/hooks/useBridgeFetch", () => ({
  useBridgeFetch: (url: string) =>
    url.includes("/approvals/")
      ? {
          data: {
            pending: {
              callId: "call-0001",
              toolName: "file.write",
              tier: "high",
              requestedAt: Date.now(),
              expiresAt: null,
            },
            decision: null,
            nearby: [],
          },
          error: null,
          loading: false,
          status: 200,
        }
      : { data: null, error: null, loading: false, status: 200 },
}));

import ApprovalDetailPage from "../page";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("approval detail — no credential from the URL", () => {
  it("approving never sends an Authorization header taken from ?approvalToken=", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window.history, "replaceState").mockImplementation(replaceState);
    render(<ApprovalDetailPage />);
    fireEvent.click(screen.getByText(/Approve/, { selector: "span" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("scrubs a stale ?approvalToken= from the address bar", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const spy = vi.spyOn(window.history, "replaceState").mockImplementation(() => undefined);
    render(<ApprovalDetailPage />);
    expect(spy).toHaveBeenCalled();
    const url = String(spy.mock.calls[0]?.[2] ?? "");
    expect(url).not.toContain("approvalToken");
  });
});
