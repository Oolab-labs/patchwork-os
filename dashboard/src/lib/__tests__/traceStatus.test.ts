/**
 * Regression test for /traces rendering terminal runs as "running".
 *
 * `traceStatus()` used `"running"` as a catch-all, so terminal halt
 * statuses (interrupted / cancelled) rendered as still-active. The fix
 * routes them through the canonical `isHaltStatus()` helper (which
 * covers error/failed/cancelled/interrupted), keeping the page in sync
 * with the rest of the dashboard.
 */

import { describe, expect, it } from "vitest";
import { traceStatus } from "@/lib/traceStatus";

const withStatus = (status: string) => ({ body: { status } });

describe("traceStatus", () => {
  it("treats interrupted as an error (terminal), not running", () => {
    expect(traceStatus(withStatus("interrupted"))).toBe("error");
  });

  it("treats cancelled as an error (terminal), not running", () => {
    expect(traceStatus(withStatus("cancelled"))).toBe("error");
  });

  it("still maps error/failed/rejected/errored to error", () => {
    expect(traceStatus(withStatus("error"))).toBe("error");
    expect(traceStatus(withStatus("failed"))).toBe("error");
    expect(traceStatus(withStatus("rejected"))).toBe("error");
    expect(traceStatus(withStatus("errored"))).toBe("error");
  });

  it("maps ok/done/success/approved to done", () => {
    expect(traceStatus(withStatus("ok"))).toBe("done");
    expect(traceStatus(withStatus("done"))).toBe("done");
    expect(traceStatus(withStatus("success"))).toBe("done");
    expect(traceStatus(withStatus("approved"))).toBe("done");
  });

  it("maps an actual running status to running", () => {
    expect(traceStatus(withStatus("running"))).toBe("running");
  });

  it("falls back to outcome when status is absent", () => {
    expect(traceStatus({ body: { outcome: "cancelled" } })).toBe("error");
  });
});
