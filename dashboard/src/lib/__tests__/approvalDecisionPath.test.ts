import { describe, expect, it } from "vitest";
import { approvalDecisionPath } from "../approvalDecisionPath";

describe("approvalDecisionPath", () => {
  it("targets the bridge's approve/reject routes with no /approvals/ prefix", () => {
    expect(approvalDecisionPath("approve", "call-1")).toBe("/api/bridge/approve/call-1");
    expect(approvalDecisionPath("reject", "call-1")).toBe("/api/bridge/reject/call-1");
  });

  it("produces exactly two segments after /api/bridge, the shape the proxy attributes", () => {
    const segments = approvalDecisionPath("approve", "abc-123")
      .replace(/^\/api\/bridge\//, "")
      .split("/");
    expect(segments).toEqual(["approve", "abc-123"]);
  });

  it("encodes a call id so it cannot add a path segment", () => {
    expect(approvalDecisionPath("reject", "a/b")).toBe("/api/bridge/reject/a%2Fb");
  });
});
