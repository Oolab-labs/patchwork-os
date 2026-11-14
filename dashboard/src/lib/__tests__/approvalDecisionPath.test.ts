import { describe, expect, it } from "vitest";
import {
  approvalDecisionPath,
  decisionFailureText,
} from "../approvalDecisionPath";

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

describe("decisionFailureText", () => {
  const res = (body: string, status = 403) => new Response(body, { status });

  it("shows the bridge's message for a separation-of-duties refusal", async () => {
    const text = await decisionFailureText(
      res(
        JSON.stringify({
          error: "self_approval",
          message:
            "You started this run, so another member must approve this step.",
        }),
      ),
    );
    expect(text).toBe(
      "You started this run, so another member must approve this step.",
    );
  });

  it("falls back to the error code, then the raw text, then the status", async () => {
    expect(await decisionFailureText(res(JSON.stringify({ error: "x" })))).toBe("x");
    expect(await decisionFailureText(res("plain words"))).toBe("plain words");
    expect(await decisionFailureText(res("", 502))).toBe("HTTP 502");
  });
});
