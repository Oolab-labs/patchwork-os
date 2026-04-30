/**
 * Smoke test for the dashboard test rig (vitest + tsx + path alias).
 *
 * Picks a pure utility (`previewMockedReplay`) so a failure here means the
 * test rig is broken, not the code under test. Replace / expand under
 * dashboard/src/lib/__tests__/ as real coverage arrives.
 */

import { describe, expect, it } from "vitest";
import { previewMockedReplay } from "@/lib/registryDiff";

describe("rig smoke: previewMockedReplay", () => {
  it("classifies steps with output as mocked", () => {
    const out = previewMockedReplay([
      { id: "s1", status: "ok", output: { x: 1 } },
    ]);
    expect(out.mocked).toEqual(["s1"]);
    expect(out.unmocked).toEqual([]);
  });

  it("flags steps with no captured output as unmocked (no-capture)", () => {
    const out = previewMockedReplay([
      { id: "s2", status: "ok", tool: "github.listIssues" },
    ]);
    expect(out.mocked).toEqual([]);
    expect(out.unmocked).toEqual([
      { id: "s2", tool: "github.listIssues", reason: "no-capture" },
    ]);
  });

  it("skips skipped steps entirely", () => {
    const out = previewMockedReplay([{ id: "s3", status: "skipped" }]);
    expect(out.mocked).toEqual([]);
    expect(out.unmocked).toEqual([]);
  });
});
