"use client";

/**
 * Recipe detail hub — shared layout ("Dossier", mockup D-A).
 *
 * Wraps `/recipes/[name]` (Overview), `/edit`, and `/plan`. The old
 * tab-bar (role=tablist, Overview/Edit/Plan) is gone — Edit and Plan are
 * now plain links inside a sticky identity rail, alongside the primary
 * actions (Run now / Enable-disable / Edit YAML) and the relation links
 * that used to live in a separate RelationStrip.
 *
 * The rail renders once here and persists across Overview/Edit/Plan
 * navigation. On Overview, `{children}` fills the `.rd-stack` content
 * area next to the rail. Edit/Plan keep their own full-width body (their
 * layouts don't fit the rail's two-column grid), so the grid is skipped
 * on those routes and only the rail is shown above the sub-page body.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useEffect, useMemo } from "react";
import { canonicalRecipeKey } from "@/lib/entityKey";
import { detectConnectorsForRecipe } from "@/lib/recipeConnectors";
import { Breadcrumb, EmptyState, StatusPill } from "@/components/patchwork";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import { statusPillFor } from "@/lib/recipeHeaderStatus";
import { useRailData } from "./_components/RailContext";

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

function basePath(name: string): string {
  return `/recipes/${encodeURIComponent(name)}`;
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

interface RelationLink {
  label: string;
  href: string;
  title: string;
  tone?: "warn";
}

/** The sticky identity rail — name, status, primary actions, fact list,
 *  relation links (incl. Edit/Plan section links), and the danger zone. */
function RecipeRail({
  name,
  recipe,
  recipesLoaded,
  isEditRoute,
  isPlanRoute,
}: {
  name: string;
  recipe: RecipeSummary | undefined;
  recipesLoaded: boolean;
  isEditRoute: boolean;
  isPlanRoute: boolean;
}) {
  const { tone, label } = statusPillFor(recipe, recipesLoaded);
  const enabledStatus = recipe ? recipe.enabled !== false : null;

  const connectors = useMemo(
    () => (recipe ? detectConnectorsForRecipe(recipe) : []),
    [recipe],
  );

  // Overview publishes richer rail data (run/toggle/delete handlers, facts,
  // needs-you rows) via context. On Edit/Plan (or before Overview mounts)
  // this is null — the rail then shows identity + nav only, no actions.
  const rail = useRailData();

  const relationLinks: RelationLink[] = useMemo(() => {
    const enc = encodeURIComponent(name);
    const items: RelationLink[] = [
      { label: "Runs for this recipe →", href: `/runs?recipe=${enc}`, title: `Runs of ${name}` },
      {
        label: "Halts →",
        href: `/runs?recipe=${enc}&halt=1`,
        tone: "warn",
        title: `Halted runs of ${name}`,
      },
      { label: "Traces →", href: `/traces?recipe=${enc}`, title: `Decision traces for ${name}` },
      { label: "Inbox →", href: `/inbox?recipe=${enc}`, title: `Inbox outputs from ${name}` },
      { label: "Approvals →", href: `/approvals?recipe=${enc}`, title: `Approvals for ${name}` },
      { label: "Compare versions →", href: `/recipes/compare?name=${enc}`, title: `Compare versions of ${name}` },
    ];
    for (const c of connectors) {
      items.push({ label: `Connector: ${c} →`, href: `/connections#${c}`, title: `Connector: ${c}` });
    }
    return items;
  }, [name, connectors]);

  return (
    <aside className="rd-rail card">
      <div>
        <div className="muted rd-crumb">
          <RecipeBreadcrumb name={name} />
        </div>
        <div className="nm mono">
          {name}{" "}
          <span className={enabledStatus === true ? "recipe-hub-status-pill-enabled" : undefined} style={{ borderRadius: 999 }}>
            <StatusPill tone={tone}>{label}</StatusPill>
          </span>
        </div>
        {recipe?.description && <div className="desc">{recipe.description}</div>}
      </div>

      {/* Primary actions — published by the Overview page via RailProvider.
          Absent on Edit/Plan (and before Overview mounts), so this block
          just doesn't render there — no dead buttons on those routes. */}
      {rail && !isEditRoute && !isPlanRoute && (
        <div className="rd-rail-actions">
          <button
            type="button"
            className="btn primary"
            onClick={rail.onRunNow}
            disabled={rail.runDisabled}
            title={rail.runDisabled ? "This job is paused — resume it first" : "Run this job now"}
          >
            ▶ Run now
          </button>
          <button
            type="button"
            className="btn"
            onClick={rail.onToggle}
            disabled={rail.toggling}
            aria-pressed={rail.enabled}
          >
            {rail.toggling ? (rail.enabled ? "Pausing…" : "Resuming…") : rail.enabled ? "Pause" : "Resume"}
          </button>
          <Link href={`${basePath(name)}/edit`} className="btn ghost" style={{ textDecoration: "none", textAlign: "center" }}>
            Edit YAML
          </Link>
        </div>
      )}

      {rail && rail.needs.length > 0 && !isEditRoute && !isPlanRoute && (
        <div className="rd-needs" role="alert">
          {rail.needs.map((n) => (
            <div key={n.key} className="rd-needs-row">
              <span>{n.sentence}</span>
              {n.fix && (
                <button type="button" className="btn sm primary" onClick={rail.onResumeFix}>
                  {n.fix.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {rail && (
        <div className="rd-facts num">
          <div>
            <span className="k">Trigger</span>
            <span className="mono">{rail.trigger}</span>
          </div>
          <div>
            <span className="k">Last run</span>
            <span>
              {rail.lastRunWhen ? (
                <>
                  <StatusPill tone={rail.lastRunTone ?? "muted"}>{rail.lastRunLabel}</StatusPill>{" "}
                  {rail.lastRunWhen}
                </>
              ) : (
                "never"
              )}
            </span>
          </div>
          <div>
            <span className="k">Success</span>
            <span>{rail.successPct == null ? "—" : `${rail.successPct.toFixed(0)}%`}</span>
          </div>
          <div>
            <span className="k">Avg duration</span>
            <span>{rail.avgDuration}</span>
          </div>
          {rail.connectors.map((c) => (
            <div key={c.id}>
              <span className="k">Connector</span>
              <span className={`pill ${c.healthy === false ? "err" : c.healthy === true ? "ok" : ""}`}>
                {c.healthy === false && <span className="dot err" />} {c.id}
              </span>
            </div>
          ))}
        </div>
      )}

      <nav className="rd-nav" aria-label="Recipe sections">
        <Link
          href={basePath(name)}
          className={`rd-nav-link${!isEditRoute && !isPlanRoute ? " is-active" : ""}`}
          aria-current={!isEditRoute && !isPlanRoute ? "page" : undefined}
        >
          Overview
        </Link>
        <Link
          href={`${basePath(name)}/edit`}
          className={`rd-nav-link${isEditRoute ? " is-active" : ""}`}
          aria-current={isEditRoute ? "page" : undefined}
        >
          Edit YAML
        </Link>
        <Link
          href={`${basePath(name)}/plan`}
          className={`rd-nav-link${isPlanRoute ? " is-active" : ""}`}
          aria-current={isPlanRoute ? "page" : undefined}
        >
          Plan
        </Link>
      </nav>

      <div className="rd-links">
        {relationLinks.map((l) => (
          <a key={l.label} href={l.href} title={l.title} style={l.tone === "warn" ? { color: "var(--warn)" } : undefined}>
            {l.label}
          </a>
        ))}
      </div>

      {rail && !isEditRoute && !isPlanRoute && (
        <div className="rd-danger">
          <button type="button" className="btn sm ghost danger" onClick={rail.onDelete}>
            Delete
          </button>
        </div>
      )}
    </aside>
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
  const pathname = usePathname() ?? "";
  // The [...name] catch-all captures "edit" and "plan" as trailing segments
  // when the user is on those sub-tabs. Strip them so the layout's name always
  // refers to the actual recipe — not "my-recipe/edit".
  const TAB_SUFFIXES = new Set(["edit", "plan"]);
  const lastSegment = rawNameParts[rawNameParts.length - 1];
  const nameParts =
    rawNameParts.length > 1 && TAB_SUFFIXES.has(lastSegment ?? "")
      ? rawNameParts.slice(0, -1)
      : rawNameParts;
  const name = canonicalRecipeKey(decodeURIComponent(nameParts.join("/")));
  const isEditRoute = lastSegment === "edit" || pathname.endsWith("/edit");
  const isPlanRoute = lastSegment === "plan" || pathname.endsWith("/plan");

  // Resolve the recipe from the list endpoint. Cheap, cached, and the
  // single-recipe `/api/bridge/recipes/[name]` returns raw YAML rather
  // than the structured Recipe row we need for the rail.
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

  if (notFound) {
    return (
      <section>
        <RecipeBreadcrumb name={name} />
        <div style={{ marginTop: 16 }}>
          <EmptyState
            title="Recipe not found"
            description={`No recipe named "${name}" is installed.`}
            action={
              <Link href="/recipes" className="btn primary" style={{ textDecoration: "none" }}>
                Back to recipes
              </Link>
            }
          />
        </div>
      </section>
    );
  }

  // Edit/Plan bodies are full-width forms/DAGs that don't fit the
  // two-column dossier grid — show the rail above them, not beside them.
  if (isEditRoute || isPlanRoute) {
    return (
      <section>
        <RecipeRail
          name={name}
          recipe={recipe}
          recipesLoaded={recipesLoaded}
          isEditRoute={isEditRoute}
          isPlanRoute={isPlanRoute}
        />
        <div style={{ marginTop: 20 }}>{children}</div>
      </section>
    );
  }

  return (
    <section className="rd-layout">
      <RecipeRail
        name={name}
        recipe={recipe}
        recipesLoaded={recipesLoaded}
        isEditRoute={isEditRoute}
        isPlanRoute={isPlanRoute}
      />
      <div className="rd-stack">{children}</div>
    </section>
  );
}
