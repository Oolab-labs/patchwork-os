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
import { detectConnectorsForRecipe } from "@/lib/recipeConnectors";
import { Breadcrumb, RelationStrip, StatusPill } from "@/components/patchwork";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { statusPillFor } from "@/lib/recipeHeaderStatus";

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
            className="recipe-hub-tab-link"
            style={{
              padding: "8px 14px",
              fontSize: "var(--fs-s)",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--accent)" : "var(--ink-2)",
              textDecoration: "none",
              borderBottom: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
              marginBottom: -1,
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

export default function RecipeDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string[] }>;
}) {
  const { name: rawNameParts } = use(params);
  // The [...name] catch-all captures "edit" and "plan" as trailing segments
  // when the user is on those sub-tabs. Strip them so the layout's name always
  // refers to the actual recipe — not "my-recipe/edit".
  const TAB_SUFFIXES = new Set(["edit", "plan"]);
  const nameParts =
    rawNameParts.length > 1 &&
    TAB_SUFFIXES.has(rawNameParts[rawNameParts.length - 1] ?? "")
      ? rawNameParts.slice(0, -1)
      : rawNameParts;
  const name = canonicalRecipeKey(decodeURIComponent(nameParts.join("/")));

  // Resolve the recipe from the list endpoint. Cheap, cached, and the
  // single-recipe `/api/bridge/recipes/[name]` returns raw YAML rather
  // than the structured Recipe row we need for the header.
  const { data: recipes } = useBridgeFetch<RecipeSummary[]>(
    "/api/bridge/recipes",
    {
      intervalMs: 10_000,
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

  // `recipes` is undefined until the list resolves; once it's an array
  // (even empty) the list has loaded, so an absent recipe is "not found".
  const recipesLoaded = recipes !== undefined;
  const notFound = recipesLoaded && !recipe;
  const { tone, label } = statusPillFor(recipe, recipesLoaded);
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

  const enabledStatus = recipe ? recipe.enabled !== false : null;

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
            className="recipe-hub-h1"
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-2xl, 1.5rem)",
            }}
          >
            {name}
          </h1>
          <span className={enabledStatus === true ? "recipe-hub-status-pill-enabled" : undefined} style={{ borderRadius: 999 }}>
            <StatusPill tone={tone}>{label}</StatusPill>
          </span>
        </div>
        {recipe?.description && (
          <div
            style={{
              marginTop: 8,
              color: "var(--ink-2)",
              fontSize: "var(--fs-s)",
              lineHeight: 1.5,
              animation: "layoutHeadIn 240ms 60ms ease both",
              animationFillMode: "both",
            }}
          >
            {recipe.description}
          </div>
        )}
        {/* When the recipe doesn't exist, the relation links + section
            tabs all point at a nonexistent recipe (Runs/Traces/Edit/Plan
            of nothing). Suppress them so the not-found body is the only
            thing on screen. */}
        {!notFound && (
          <>
            <div className="recipe-relation-strip">
              <RelationStrip items={relationItems} />
            </div>
            <TabBar name={name} />
          </>
        )}
      </div>
      {children}
    </section>
  );
}
