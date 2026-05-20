/**
 * Locks the visual contract of <Breadcrumb>. This is the unified primitive
 * that replaced three divergent breadcrumb patterns across the dashboard
 * (IA audit, 2026-05-20). Tests here are about rendered output — anyone
 * refactoring internals should keep the href/aria-current/separator contract.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Breadcrumb } from "@/components/patchwork/Breadcrumb";

describe("<Breadcrumb/>", () => {
  it("renders a nav with aria-label Breadcrumb", () => {
    const { container } = render(
      <Breadcrumb items={[{ label: "Recipes", href: "/recipes" }, { label: "my-recipe" }]} />,
    );
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Breadcrumb");
  });

  it("renders items as an ordered list", () => {
    const { container } = render(
      <Breadcrumb items={[{ label: "Runs", href: "/runs" }, { label: "Run #42" }]} />,
    );
    expect(container.querySelector("ol")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("last item has aria-current=page and is not a link", () => {
    const { container } = render(
      <Breadcrumb items={[{ label: "Sessions", href: "/sessions" }, { label: "ses-123" }]} />,
    );
    const items = container.querySelectorAll("li");
    const last = items[items.length - 1];
    expect(last.getAttribute("aria-current")).toBe("page");
    // Current page item must not contain an anchor
    expect(last.querySelector("a")).toBeNull();
  });

  it("items with href are rendered as Next.js links", () => {
    const { container } = render(
      <Breadcrumb
        items={[
          { label: "Approvals", href: "/approvals" },
          { label: "call-xyz" },
        ]}
      />,
    );
    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("/approvals");
    expect(anchors[0].textContent).toBe("Approvals");
  });

  it("renders separator between items", () => {
    const { container } = render(
      <Breadcrumb
        items={[
          { label: "Recipes", href: "/recipes" },
          { label: "my-recipe" },
        ]}
      />,
    );
    // Separator spans have aria-hidden="true"
    const separators = container.querySelectorAll("[aria-hidden='true']");
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it("renders single-item breadcrumb (current page only)", () => {
    const { container } = render(
      <Breadcrumb items={[{ label: "Dashboard" }]} />,
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute("aria-current")).toBe("page");
  });

  it("supports three-level trail with two linked ancestors", () => {
    const { container } = render(
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Settings", href: "/settings" },
          { label: "Inbox Delivery" },
        ]}
      />,
    );
    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(2);
    expect(anchors[0].getAttribute("href")).toBe("/");
    expect(anchors[1].getAttribute("href")).toBe("/settings");
    const items = container.querySelectorAll("li");
    expect(items[items.length - 1].getAttribute("aria-current")).toBe("page");
  });
});
