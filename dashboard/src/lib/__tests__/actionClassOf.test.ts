/**
 * The approval queue renders the BRIDGE's action class (audit M27). The
 * dashboard used to re-derive it from a partial copy: an unknown tool came
 * back null and was sorted, badged and gated as reversible.
 */
import { describe, expect, it } from "vitest";
import { blastBadge } from "@/components/patchwork/BlastBadge";
import { actionClassOf } from "@/lib/actionClass";

describe("actionClassOf", () => {
  it("prefers the class the bridge sent", () => {
    const c = actionClassOf({
      toolName: "file.write",
      actionClass: { domain: "fs-write", reversibility: "reversible", blastTier: "low" },
    });
    expect(c?.domain).toBe("fs-write");
    expect(c?.reversibility).toBe("reversible");
    expect(c?.unclassified).toBeFalsy();
  });

  it("an unknown tool the bridge classes as `other` is UNCLASSIFIED but irreversible", () => {
    const c = actionClassOf({
      toolName: "unknown.vendor_send",
      actionClass: { domain: "other", reversibility: "irreversible", blastTier: "medium" },
    });
    expect(c?.unclassified).toBe(true);
    expect(c?.reversibility).toBe("irreversible");
    const b = blastBadge(c);
    expect(b.label).toContain("unclassified");
    expect(b.label).toContain("irreversible");
    expect(b.tone).toBe("err");
  });

  it("falls back to the local copy only when the bridge sent nothing (older bridge)", () => {
    expect(actionClassOf({ toolName: "gitPush" })?.reversibility).toBeDefined();
    expect(actionClassOf({ toolName: "unknown.vendor_send" })).toBeNull();
  });
});
