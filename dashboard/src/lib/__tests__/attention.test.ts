import { describe, expect, it } from "vitest";
import {
  type AttentionItem,
  bandSeverity,
  buildAttentionItems,
} from "../attention";

describe("buildAttentionItems", () => {
  it("omits any category with a zero count", () => {
    expect(
      buildAttentionItems({ pendingCount: 0, haltCount24h: 0, failingCount24h: 0 }),
    ).toEqual([]);
  });

  it("orders approvals → failed runs → halts", () => {
    const items = buildAttentionItems({
      pendingCount: 2,
      haltCount24h: 1,
      failingCount24h: 3,
    });
    expect(items.map((i) => i.href)).toEqual([
      "/approvals",
      "/runs?window=24h",
      "/runs?halt=1",
    ]);
  });

  it("marks failed runs and halts as 'err', approvals as 'warn' (no inversion)", () => {
    const items = buildAttentionItems({
      pendingCount: 1,
      haltCount24h: 1,
      failingCount24h: 1,
    });
    const bySeverity = Object.fromEntries(
      items.map((i) => [i.href, i.severity]),
    );
    // The bug being fixed: failed runs / halts are more severe than a pending
    // approval, so they must render in the higher-alarm err (red) register —
    // never below an approval's warn (amber).
    expect(bySeverity["/runs?window=24h"]).toBe("err");
    expect(bySeverity["/runs?halt=1"]).toBe("err");
    expect(bySeverity["/approvals"]).toBe("warn");
  });

  it("pluralises labels on the count", () => {
    const one = buildAttentionItems({ pendingCount: 1, haltCount24h: 1, failingCount24h: 1 });
    expect(one.find((i) => i.href === "/approvals")?.label).toBe("approval pending");
    expect(one.find((i) => i.href === "/runs?window=24h")?.label).toBe("run failed · 24h");
    expect(one.find((i) => i.href === "/runs?halt=1")?.label).toBe("halt · 24h");

    const many = buildAttentionItems({ pendingCount: 2, haltCount24h: 2, failingCount24h: 2 });
    expect(many.find((i) => i.href === "/approvals")?.label).toBe("approvals pending");
    expect(many.find((i) => i.href === "/runs?window=24h")?.label).toBe("runs failed · 24h");
    expect(many.find((i) => i.href === "/runs?halt=1")?.label).toBe("halts · 24h");
  });
});

describe("bandSeverity", () => {
  it("is 'err' when any err item is present", () => {
    const items: AttentionItem[] = [
      { count: 1, label: "approvals pending", href: "/approvals", severity: "warn" },
      { count: 1, label: "runs failed · 24h", href: "/runs?window=24h", severity: "err" },
    ];
    expect(bandSeverity(items)).toBe("err");
  });

  it("is 'warn' when only warn items are present (approvals only)", () => {
    const items = buildAttentionItems({ pendingCount: 3, haltCount24h: 0, failingCount24h: 0 });
    expect(bandSeverity(items)).toBe("warn");
  });
});
