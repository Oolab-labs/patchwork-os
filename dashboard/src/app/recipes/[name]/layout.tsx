"use client";

/**
 * Recipe detail hub — shared layout.
 *
 * Wraps `/recipes/[name]` (Overview), `/edit`, and `/plan` so the recipe
 * is the anchor of the journey instead of three independent pages. The
 * Overview hub is the new landing point from the recipes list (PR
 * `feat/recipe-detail-hub`, Phase 1). Edit + Plan still render their
 * own bodies below this header — Phase 4 will retire their duplicate
 * page-heads.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { use, useEffect, useMemo, useRef } from "react";
import { canonicalRecipeKey } from "@/lib/entityKey";
import { Breadcrumb, RelationStrip, StatusPill } from "@/components/patchwork";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";

interface RecipeSummary {
  name: string;
  description?: string;
  trigger?: string;
  enabled?: boolean;
  lint?: { ok: boolean; errorCount: number; warningCount: number };
}

interface RecipesListResponse {
  recipes?: RecipeSummary[];
}

// Tool prefix → connector name. Copy of detectConnectors() from the list
// page, narrowed to a single recipe. Kept inline to avoid a cross-file
// refactor in Phase 1 (task explicitly defers that).
const TOOL_PREFIX_MAP: Record<string, string> = {
  slack_: "slack",
  github_: "github",
  jira_: "jira",
  linear_: "linear",
  gmail_: "gmail",
  calendar_: "googleCalendar",
  intercom_: "intercom",
  hubspot_: "hubspot",
  datadog_: "datadog",
  stripe_: "stripe",
  sentry_: "sentry",
};

export function detectConnectorsForRecipe(recipe: RecipeSummary): string[] {
  const haystack = `${recipe.name} ${recipe.description ?? ""}`.toLowerCase();
  const found = new Set<string>();
  for (const [prefix, connector] of Object.entries(TOOL_PREFIX_MAP)) {
    const keyword = prefix.replace(/_$/, "");
    if (haystack.includes(prefix) || haystack.includes(keyword)) {
      found.add(connector);
    }
  }
  return Array.from(found).sort();
}

type TabKey = "overview" | "edit" | "plan";

interface TabSpec {
  key: TabKey;
  label: string;
  href: (name: string) => string;
  match: (pathname: string, name: string) => boolean;
}

function basePath(name: string): string {
  return `/recipes/${encodeURIComponent(name)}`;
}

const TABS: TabSpec[] = [
  {
    key: "overview",
    label: "Overview",
    href: (n) => basePath(n),
    match: (p, n) => p === basePath(n) || p === `${basePath(n)}/`,
  },
  {
    key: "edit",
    label: "Edit",
    href: (n) => `${basePath(n)}/edit`,
    match: (p, n) => p.startsWith(`${basePath(n)}/edit`),
  },
  {
    key: "plan",
    label: "Plan",
    href: (n) => `${basePath(n)}/plan`,
    match: (p, n) => p.startsWith(`${basePath(n)}/plan`),
  },
];

function TabBar({ name }: { name: string }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const activeIdx = useMemo(() => {
    const i = TABS.findIndex((t) => t.match(pathname, name));
    return i < 0 ? 0 : i;
  }, [pathname, name]);

  function onKey(e: React.KeyboardEvent<HTMLAnchorElement>, idx: number) {
    let next = idx;
    if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      router.push(TABS[idx].href(name));
      return;
    } else return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Recipe sections"
      style={{
        display: "flex",
        gap: 4,
        marginTop: 12,
        borderBottom: "1px solid var(--line-2)",
      }}
    >
      {TABS.map((t, i) => {
        const isActive = i === activeIdx;
        return (
          <Link
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            href={t.href(name)}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            style={{
              padding: "8px 14px",
              fontSize: "var(--fs-s)",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--accent)" : "var(--ink-2)",
              textDecoration: "none",
              borderBottom: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
              marginBottom: -1,
              transition: "color 120ms, border-color 120ms",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

function RecipeBreadcrumb({ name }: { name: string }) {
  return (
    <Breadcrumb
      items={[
        { label: "Recipes", href: "/recipes" },
        { label: name },
      ]}
    />
  );
}

function statusPillFor(recipe: RecipeSummary | undefined): {
  tone: "ok" | "warn" | "err" | "muted";
  label: string;
} {
  if (!recipe) return { tone: "muted", label: "loading" };
  if (recipe.lint && recipe.lint.ok === false) return { tone: "err", label: "lint error" };
  if (recipe.enabled === false) return { tone: "muted", label: "disabled" };
  return { tone: "ok", label: "enabled" };
}

export default function RecipeDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = use(params);
  const name = canonicalRecipeKey(decodeURIComponent(rawName));

  // Resolve the recipe from the list endpoint. Cheap, cached, and the
  // single-recipe `/api/bridge/recipes/[name]` returns raw YAML rather
  // than the structured Recipe row we need for the header.
  const { data: recipes } = useBridgeFetch<RecipeSummary[]>(
    "/api/bridge/recipes",
    {
      intervalMs: 30_000,
      transform: (raw) => {
        if (Array.isArray(raw)) return raw as RecipeSummary[];
        const obj = raw as RecipesListResponse;
        return obj?.recipes ?? [];
      },
    },
  );

  const recipe = useMemo(
    () => recipes?.find((r) => canonicalRecipeKey(r.name) === name),
    [recipes, name],
  );

  // Set document title so browser tabs reflect the recipe.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.title;
    document.title = `${name} · Recipes · Patchwork`;
    return () => {
      document.title = prev;
    };
  }, [name]);

  const { tone, label } = statusPillFor(recipe);
  const connectors = useMemo(
    () => (recipe ? detectConnectorsForRecipe(recipe) : []),
    [recipe],
  );

  const relationItems = useMemo(() => {
    const enc = encodeURIComponent(name);
    const items = [
      { label: "Runs", href: `/runs?recipe=${enc}`, title: `Runs of ${name}` },
      {
        label: "Halts",
        href: `/runs?recipe=${enc}&halt=1`,
        tone: "warn" as const,
        title: `Halted runs of ${name}`,
      },
      { label: "Traces", href: `/traces?recipe=${enc}`, title: `Decision traces for ${name}` },
      { label: "Inbox", href: `/inbox?recipe=${enc}`, title: `Inbox outputs from ${name}` },
      { label: "Approvals", href: `/approvals?recipe=${enc}`, title: `Approvals for ${name}` },
    ];
    for (const c of connectors) {
      items.push({ label: c, href: `/connections#${c}`, title: `Connector: ${c}` });
    }
    items.push({ label: "Edit", href: `/recipes/${enc}/edit`, title: "Edit YAML" });
    items.push({ label: "Plan", href: `/recipes/${enc}/plan`, title: "Dry-run plan" });
    return items;
  }, [name, connectors]);

  return (
    <section>
      <div style={{ marginBottom: 16 }}>
        <RecipeBreadcrumb name={name} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-2xl, 1.5rem)",
            }}
          >
            {name}
          </h1>
          <StatusPill tone={tone}>{label}</StatusPill>
        </div>
        {recipe?.description && (
          <div
            style={{
              marginTop: 6,
              color: "var(--ink-3)",
              fontSize: "var(--fs-s)",
            }}
          >
            {recipe.description}
          </div>
        )}
        <RelationStrip items={relationItems} />
        <TabBar name={name} />
      </div>
      {children}
    </section>
  );
}
