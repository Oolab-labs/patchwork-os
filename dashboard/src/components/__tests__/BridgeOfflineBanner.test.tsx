/**
 * Verifies the bridge-offline diagnostic contract:
 *   - hidden when status.ok is true
 *   - hidden when status.degraded is true (partial — banner would be misleading)
 *   - rendered when bridge is fully offline, with a CLI command + last-attempt info
 *   - dismissable via sessionStorage (so a new tab still sees the warning)
 */

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeOfflineBanner } from "@/components/BridgeOfflineBanner";

describe("<BridgeOfflineBanner/>", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("does not render when bridge is online", () => {
    const { container } = render(
      <BridgeOfflineBanner status={{ ok: true, port: 3101 }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("does not render when bridge is in the degraded fallback state", () => {
    // Degraded = /status failed but /approvals responded. We trust the
    // SSE fallback path enough to not scream a red banner.
    const { container } = render(
      <BridgeOfflineBanner status={{ ok: false, degraded: true }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the diagnostic when bridge is fully offline", () => {
    const { getByText, container } = render(
      <BridgeOfflineBanner
        status={{
          ok: false,
          degraded: false,
          lastAttemptAt: Date.now() - 3000,
          lastError: "Failed to fetch",
        }}
      />,
    );
    expect(getByText(/Bridge offline/i)).toBeInTheDocument();
    expect(container.textContent).toMatch(/last attempt/i);
    expect(container.textContent).toMatch(/Failed to fetch/);
    expect(container.textContent).toMatch(/patchwork start --port/);
  });

  it("uses the configured port from patchwork.port (preferred over status.port)", () => {
    const { container } = render(
      <BridgeOfflineBanner
        status={{
          ok: false,
          degraded: false,
          port: 3101,
          patchwork: { port: 8080 },
        }}
      />,
    );
    expect(container.textContent).toMatch(/--port 8080/);
  });

  it("falls back to the documented default port when none is reported", () => {
    const { container } = render(
      <BridgeOfflineBanner status={{ ok: false, degraded: false }} />,
    );
    expect(container.textContent).toMatch(/--port 3101/);
  });

  it("hides itself after the user dismisses + persists across remounts in the same session", () => {
    const status = { ok: false as const, degraded: false };
    const { getByRole, container, unmount } = render(
      <BridgeOfflineBanner status={status} />,
    );
    expect(container.firstChild).not.toBeNull();
    fireEvent.click(getByRole("button", { name: /dismiss/i }));
    expect(container.firstChild).toBeNull();

    // Unmount the original tree, then mount a fresh instance with the
    // same offline status: the dismissal must survive via sessionStorage
    // (a new tab/refresh, NOT just a re-render in the same React root).
    unmount();
    const { container: c2 } = render(<BridgeOfflineBanner status={status} />);
    expect(c2.firstChild).toBeNull();
  });
});
