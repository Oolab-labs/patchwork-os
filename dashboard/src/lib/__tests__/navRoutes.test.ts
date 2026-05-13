/**
 * Locks the navigation contract shared by the sidebar, command palette,
 * and mobile bottom-nav. The IA reorg (2026-05-12) made navRoutes the
 * single source of truth — these tests catch regressions where a future
 * edit drops a page, duplicates a route, or breaks the section grouping
 * those three components rely on.
 */

import { describe, expect, it } from "vitest";
import {
  NAV_SECTIONS,
  MOBILE_PRIMARY_HREFS,
  flatRoutes,
  findRoute,
  moreRoutes,
} from "@/lib/navRoutes";

describe("navRoutes contract", () => {
  it("has the six IA sections in the expected order", () => {
    const titles = NAV_SECTIONS.map((s) => s.title);
    expect(titles).toEqual([
      "Today",
      "Decisions",
      "Activity",
      "Build",
      "Insights",
      "Setup",
    ]);
  });

  it("exposes every dashboard page in the sidebar (no orphans)", () => {
    const hrefs = new Set(flatRoutes().map((r) => r.href));
    // Every page directory under dashboard/src/app/ that isn't a
    // /[param] detail, an /api route, /login, or a connections OAuth
    // callback must have a sidebar entry. The IA audit found 4
    // dashboard pages with zero sidebar entry point (/decisions,
    // /insights, /metrics, /suggestions) and 4 reachable only via
    // hidden tab clusters (/runs, /tasks, /sessions, /traces). Both
    // sets are surfaced by this test.
    const expected = [
      "/",
      "/inbox",
      "/approvals",
      "/suggestions",
      "/decisions",
      "/activity",
      "/runs",
      "/tasks",
      "/sessions",
      "/traces",
      "/recipes",
      "/marketplace",
      "/analytics",
      "/insights",
      "/transactions",
      "/connections",
      "/settings",
    ];
    for (const href of expected) {
      expect(hrefs, `missing nav entry for ${href}`).toContain(href);
    }
  });

  it("does not list pages that have been redirected away", () => {
    // /metrics was folded into /analytics and /recipes/marketplace was
    // a vestigial redirect — both are now 308s in next.config.js and
    // must not appear in the nav (or ⌘K, since it derives from nav).
    const hrefs = new Set(flatRoutes().map((r) => r.href));
    expect(hrefs).not.toContain("/metrics");
    expect(hrefs).not.toContain("/recipes/marketplace");
  });

  it("uses unique hrefs", () => {
    const all = flatRoutes().map((r) => r.href);
    expect(new Set(all).size).toBe(all.length);
  });

  it("renames /decisions to 'Knowledge' (the page renders the ctxSaveTrace knowledge base, not approval history)", () => {
    const decisions = findRoute("/decisions");
    expect(decisions).toBeDefined();
    expect(decisions?.label).toBe("Knowledge");
  });

  it("labels /insights 'Approval Insights' so users can tell it apart from /analytics", () => {
    const insights = findRoute("/insights");
    expect(insights?.label).toBe("Approval Insights");
  });

  it("badges /approvals with the approvals badge and /activity with halts", () => {
    expect(findRoute("/approvals")?.badge).toBe("approvals");
    expect(findRoute("/activity")?.badge).toBe("halts");
  });

  it("has exactly four mobile-primary routes (Overview / Inbox / Approvals / Recipes) — Activity moved to More for phone use", () => {
    expect(MOBILE_PRIMARY_HREFS).toEqual([
      "/",
      "/inbox",
      "/approvals",
      "/recipes",
    ]);
    expect(MOBILE_PRIMARY_HREFS).not.toContain("/activity");
  });

  it("partitions every route into either primary or more (no double-membership, no missing)", () => {
    const primary = new Set<string>(MOBILE_PRIMARY_HREFS);
    const more = moreRoutes().map((r) => r.href);
    const all = flatRoutes().map((r) => r.href);
    expect(more.length + primary.size).toBe(all.length);
    for (const href of more) expect(primary.has(href)).toBe(false);
  });

  it("every route declares an icon so the sidebar never falls back to a generic glyph", () => {
    for (const r of flatRoutes()) {
      expect(r.icon, `route ${r.href} is missing an icon`).toBeTruthy();
    }
  });
});
