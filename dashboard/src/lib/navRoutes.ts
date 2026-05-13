/**
 * Single source of truth for dashboard navigation.
 *
 * Sidebar (Shell), command palette, and mobile bottom-nav all read from here.
 * Before this module, each of those three components held its own hardcoded
 * copy of the route list — any nav edit had to touch three files in lockstep,
 * and one was forgotten more often than not.
 *
 * Adding a page? Add it here and only here.
 */

export type NavBadge = "approvals" | "halts";

export interface NavRoute {
  /** Path under the dashboard basePath (no `/dashboard` prefix). */
  href: string;
  /** Short label used in the sidebar + mobile nav. */
  label: string;
  /**
   * Richer label used in ⌘K to disambiguate (e.g. "Activity — Runs"
   * vs the bare "Runs" the sidebar shows under the Activity section).
   * Falls back to `label` when omitted.
   */
  paletteLabel?: string;
  /** Optional ⌘K hint column (defaults to the href). */
  paletteHint?: string;
  /** Icon key into Shell's PATHS map. */
  icon?: string;
  /** Optional live-count badge driven by Shell's pollers. */
  badge?: NavBadge;
}

export interface NavSection {
  title: string;
  routes: NavRoute[];
}

/**
 * Six-section structure mirrors the existing in-page tab clusters
 * (ActivityTabs, DecisionsTabs, AnalyticsTabs) — that way the sidebar
 * exposes every page that today is only reachable via those sub-navs.
 *
 * IA conventions:
 *   - "Today" = the morning-routine destinations.
 *   - "Decisions" = the trio Approvals/Suggestions/Knowledge.
 *     "Knowledge" is the renamed /decisions page (which renders the
 *     ctxSaveTrace knowledge base, NOT approval history — the previous
 *     "History" label was actively wrong).
 *   - "Activity" = the firehose + sub-views.
 *   - "Build" = create/install.
 *   - "Insights" = aggregate views, including the previously-hidden
 *     "Approval Insights" page (was reachable only by typing the URL).
 *   - "Setup" = configuration.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Today",
    routes: [
      { href: "/",      label: "Overview", icon: "home" },
      { href: "/inbox", label: "Inbox",    icon: "inbox" },
    ],
  },
  {
    title: "Decisions",
    routes: [
      {
        href: "/approvals",
        label: "Approvals",
        paletteLabel: "Decisions — Approvals",
        icon: "check",
        badge: "approvals",
      },
      {
        href: "/suggestions",
        label: "Suggestions",
        paletteLabel: "Decisions — Suggestions",
        icon: "lightbulb",
      },
      {
        href: "/decisions",
        label: "Knowledge",
        paletteLabel: "Decisions — Knowledge",
        icon: "bookmark",
      },
    ],
  },
  {
    title: "Activity",
    routes: [
      {
        href: "/activity",
        label: "Live",
        paletteLabel: "Activity — Live",
        icon: "activity",
        badge: "halts",
      },
      { href: "/runs",     label: "Runs",     paletteLabel: "Activity — Runs",     icon: "play" },
      { href: "/tasks",    label: "Tasks",    paletteLabel: "Activity — Tasks",    icon: "tasks" },
      { href: "/sessions", label: "Sessions", paletteLabel: "Activity — Sessions", icon: "person" },
      { href: "/traces",   label: "Traces",   paletteLabel: "Activity — Traces",   icon: "git" },
    ],
  },
  {
    title: "Build",
    routes: [
      { href: "/recipes",     label: "Recipes",     icon: "book" },
      { href: "/marketplace", label: "Marketplace", icon: "store" },
    ],
  },
  {
    title: "Insights",
    routes: [
      { href: "/analytics", label: "Analytics", icon: "trending" },
      {
        href: "/insights",
        label: "Approval Insights",
        paletteLabel: "Insights — Approval patterns",
        icon: "monitor",
      },
      {
        href: "/metrics",
        label: "Metrics",
        paletteLabel: "Insights — Prometheus metrics",
        icon: "trending",
      },
      { href: "/transactions", label: "Transactions", icon: "diff" },
    ],
  },
  {
    title: "Setup",
    routes: [
      { href: "/connections", label: "Connections", icon: "plug" },
      { href: "/settings",    label: "Settings",    icon: "settings" },
    ],
  },
];

/**
 * Mobile bottom-tab order: the 4 most-likely-destinations on a phone,
 * plus a "More" sheet exposing everything else.
 *
 * Strategic note: the previous tab set included "Activity" as the 4th
 * slot. Activity is a dense firehose — power-user content, poor mobile
 * default. Swapped for "Recipes" so the bottom row matches what users
 * actually need on a phone (read inbox, approve, create/run a recipe).
 */
export const MOBILE_PRIMARY_HREFS = ["/", "/inbox", "/approvals", "/recipes"] as const;

/** All routes, flattened in section order. */
export function flatRoutes(): NavRoute[] {
  return NAV_SECTIONS.flatMap((s) => s.routes);
}

/** Look up a route by exact href; undefined if unknown. */
export function findRoute(href: string): NavRoute | undefined {
  return flatRoutes().find((r) => r.href === href);
}

/**
 * Mobile "More" sheet shows every route that isn't in the primary 4.
 * Returns them flattened, in section order.
 */
export function moreRoutes(): NavRoute[] {
  const primary = new Set<string>(MOBILE_PRIMARY_HREFS);
  return flatRoutes().filter((r) => !primary.has(r.href));
}
