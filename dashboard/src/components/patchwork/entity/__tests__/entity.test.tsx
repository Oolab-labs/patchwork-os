/**
 * Behaviour contract for the entity-chip family (Phase 0γ).
 *
 * One file covers every chip — variant + aria + href + dispatcher routing —
 * because the surface they share is bigger than what each individually adds.
 * If a chip grows substantially, split it back out.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApprovalChip,
  ConnectorChip,
  EntityLink,
  InboxChip,
  RecipeChip,
  RunChip,
  SessionChip,
  ToolChip,
  TraceChip,
  useEntityHref,
} from "@/components/patchwork/entity";

function hrefOf(container: HTMLElement): string | null {
  const a = container.querySelector("a");
  return a ? a.getAttribute("href") : null;
}

function ariaOf(container: HTMLElement): string | null {
  const a = container.querySelector("a");
  return a ? a.getAttribute("aria-label") : null;
}

describe("<RunChip/>", () => {
  it("links to /runs/<seq>", () => {
    const { container } = render(<RunChip seq={42} />);
    expect(hrefOf(container)).toBe("/runs/42");
  });

  it("exposes aria-label with run seq and status", () => {
    const { container } = render(<RunChip seq={7} status="done" />);
    expect(ariaOf(container)).toContain("Run #7");
    expect(ariaOf(container)).toContain("done");
  });

  it("renders without throwing for every variant", () => {
    for (const v of ["chip", "row", "link"] as const) {
      const { container } = render(<RunChip seq={1} variant={v} />);
      expect(container.querySelector("a")).not.toBeNull();
    }
  });
});

describe("<RecipeChip/>", () => {
  it("routes :agent suffix through canonicalRecipeKey", () => {
    const { container } = render(<RecipeChip name="morning-pulse:agent" />);
    expect(hrefOf(container)).toBe("/recipes/morning-pulse");
  });

  it("links a bare recipe name directly", () => {
    const { container } = render(<RecipeChip name="inbox-summary" />);
    expect(hrefOf(container)).toBe("/recipes/inbox-summary");
  });

  it("aria-label uses the canonical key", () => {
    const { container } = render(<RecipeChip name="x:cron" />);
    expect(ariaOf(container)).toBe("Recipe x");
  });
});

describe("<ToolChip/>", () => {
  it("encodes special chars in the tool name", () => {
    const { container } = render(<ToolChip name="my tool/run" />);
    expect(hrefOf(container)).toBe("/insights?tool=my%20tool%2Frun");
  });

  it("exposes the risk tier in aria-label", () => {
    const { container } = render(<ToolChip name="curl" tier="high" />);
    expect(ariaOf(container)).toContain("high risk");
  });
});

describe("<SessionChip/>", () => {
  it("links to /sessions/<full-id>", () => {
    const { container } = render(<SessionChip id="01h89-abcdef-uuid" />);
    expect(hrefOf(container)).toBe("/sessions/01h89-abcdef-uuid");
  });

  it("renders only first 8 chars visibly", () => {
    const { container } = render(<SessionChip id="01h89XYZQRS" />);
    const span = container.querySelector("a span");
    expect(span?.textContent).toBe("01h89XYZ");
  });
});

describe("<ApprovalChip/>", () => {
  it("links to /approvals/<callId>", () => {
    const { container } = render(<ApprovalChip callId="call_abc123" />);
    expect(hrefOf(container)).toBe("/approvals/call_abc123");
  });

  it("aria-label includes decision verdict", () => {
    const { container } = render(
      <ApprovalChip callId="x" decision="rejected" />,
    );
    expect(ariaOf(container)).toContain("rejected");
  });
});

describe("<TraceChip/>", () => {
  it("links to /traces filtered by the trace key", () => {
    const { container } = render(
      <TraceChip traceKey="trace-1" traceType="approval" />,
    );
    expect(hrefOf(container)).toBe("/traces?q=trace-1");
  });
});

describe("<ConnectorChip/>", () => {
  it("uses a hash-anchor target (plain <a>, not Next Link)", () => {
    const { container } = render(<ConnectorChip id="github" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/connections#github");
  });

  it("labels health for screen readers", () => {
    const { container } = render(
      <ConnectorChip id="slack" healthy={false} />,
    );
    expect(ariaOf(container)).toContain("unhealthy");
  });
});

describe("<InboxChip/>", () => {
  it("strips .md for the link target but keeps the date in the visible label", () => {
    const { container } = render(
      <InboxChip name="morning-brief-2026-05-20.md" />,
    );
    expect(hrefOf(container)).toBe(
      "/inbox?item=morning-brief-2026-05-20",
    );
    const span = container.querySelector("a span");
    expect(span?.textContent).toBe("morning-brief-2026-05-20");
  });
});

describe("<EntityLink/> dispatcher", () => {
  it.each([
    ["run", "12", "/runs/12"],
    ["recipe", "foo:agent", "/recipes/foo"],
    ["tool", "curl", "/insights?tool=curl"],
    ["session", "abc", "/sessions/abc"],
    ["approval", "call_1", "/approvals/call_1"],
    ["trace", "k", "/traces?q=k"],
    ["connector", "gh", "/connections#gh"],
    ["inbox", "x.md", "/inbox?item=x"],
    ["task", "t1", "/tasks?id=t1"],
    ["decision", "d1", "/decisions?ref=d1"],
  ] as const)("kind=%s routes to %s", (kind, id, expectedHref) => {
    const { container } = render(<EntityLink kind={kind} id={id} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe(expectedHref);
  });
});

describe("useEntityHref()", () => {
  // Pure function — call directly outside a component to lock behaviour.
  it("matches every chip's link target", () => {
    expect(useEntityHref("run", "9")).toBe("/runs/9");
    expect(useEntityHref("recipe", "foo:cron")).toBe("/recipes/foo");
    expect(useEntityHref("tool", "a/b")).toBe("/insights?tool=a%2Fb");
    expect(useEntityHref("session", "s1")).toBe("/sessions/s1");
    expect(useEntityHref("approval", "c1")).toBe("/approvals/c1");
    expect(useEntityHref("trace", "t")).toBe("/traces?q=t");
    expect(useEntityHref("connector", "gh")).toBe("/connections#gh");
    expect(useEntityHref("inbox", "x.md")).toBe("/inbox?item=x");
    expect(useEntityHref("task", "t1")).toBe("/tasks?id=t1");
    expect(useEntityHref("decision", "d1")).toBe("/decisions?ref=d1");
  });
});

describe("keyboard focusability", () => {
  it("every chip renders a real <a> (focusable by default)", () => {
    const cases = [
      <RunChip key="r" seq={1} />,
      <RecipeChip key="re" name="x" />,
      <ToolChip key="t" name="x" />,
      <SessionChip key="s" id="x" />,
      <ApprovalChip key="a" callId="x" />,
      <TraceChip key="tr" traceKey="trace-1" traceType="x" />,
      <ConnectorChip key="c" id="x" />,
      <InboxChip key="i" name="x.md" />,
    ];
    for (const node of cases) {
      const { container } = render(node);
      const a = container.querySelector("a");
      expect(a).not.toBeNull();
      // <a href=…> is focusable; absent href would drop tab order.
      expect(a?.getAttribute("href")).toBeTruthy();
    }
  });
});
