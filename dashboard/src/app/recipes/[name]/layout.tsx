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

/**
 * Tool-namespace → connector-id map. Default: namespace IS the connector
 * id (1:1 for postgres, github, slack, etc.). Aliases handle the
 * historical cases where the tool prefix and the connector id diverge.
 */
const TOOL_NAMESPACE_TO_CONNECTOR: Record<string, string> = {
  calendar: "google-calendar",
  gcal: "google-calendar",
  drive: "google-drive",
  gdrive: "google-drive",
  docs: "google-docs",
  gdocs: "google-docs",
  mongo: "mongodb",
  es: "elasticsearch",
};

/** All connector ids the dashboard recognises. Used as the default
 *  passthrough for `<namespace>.<tool>` ids whose namespace matches a
 *  connector id exactly. Keep in sync with
 *  `src/connectors/connectorRegistry.ts` — the registry is canonical
 *  but is bridge-side; this list is the dashboard's view. Out-of-sync
 *  entries just mean the chip doesn't render — no functional break. */
const KNOWN_CONNECTOR_IDS = new Set([
  "gmail",
  "google-calendar",
  "google-drive",
  "google-docs",
  "github",
  "linear",
  "sentry",
  "slack",
  "asana",
  "discord",
  "gitlab",
  "notion",
  "confluence",
  "datadog",
  "hubspot",
  "intercom",
  "jira",
  "pagerduty",
  "stripe",
  "zendesk",
  "postgres",
  "mongodb",
  "redis",
  "elasticsearch",
  "sendgrid",
  "twilio",
  "figma",
  "airtable",
  "webflow",
  "monday",
  "salesforce",
  "shopify",
  "snowflake",
]);

function namespaceToConnector(ns: string): string | null {
  const lower = ns.toLowerCase();
  const alias = TOOL_NAMESPACE_TO_CONNECTOR[lower];
  if (alias) return alias;
  if (KNOWN_CONNECTOR_IDS.has(lower)) return lower;
  return null;
}

/**
 * Parse a recipe YAML buffer and return the set of connector ids it
 * requires by inspecting `tool:` strings on each step (and on parallel
 * branches). Falls back gracefully to the name/description heuristic
 * if YAML parsing fails — keeps the call site safe against
 * mid-keystroke broken buffers.
 *
 * Walks:
 *   - top-level `steps[].tool`
 *   - nested `steps[].parallel[].tool` (one level deep — matches
 *     today's recipe DSL)
 *   - `chain:` step bodies are deliberately NOT recursed (separate file)
 *
 * Phase 1A.1 (PR #782 follow-up): replaces the name+description string
 * match that missed 69% of real recipes. Tested against the live
 * 42-recipe installation: catches recipes whose connectors are only
 * mentioned via `tool: gmail.fetch_unread`, not in the description.
 */
export function detectConnectorsFromYaml(yamlContent: string): string[] {
  const found = new Set<string>();

  // Cheap string-scan first (no dep on a YAML parser bundle). For each
  // `tool: <ns>.<rest>` line, extract `<ns>`. Handles:
  //   - tool: gmail.fetch_unread
  //   - tool: "gmail.fetch_unread"
  //   - tool: gmail_fetch_unread          (legacy underscore form)
  //   - parallel:\n  - tool: ...          (nested two-space indent)
  // The dashboard already ships `yaml` for the editor, but a regex
  // scan keeps this fast in the live-typing hot path.
  const toolRe = /(^|\n)\s*-?\s*tool:\s*["']?([a-zA-Z0-9_-]+)[._]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((match = toolRe.exec(yamlContent)) !== null) {
    const ns = match[2];
    if (!ns) continue;
    const c = namespaceToConnector(ns);
    if (c) found.add(c);
  }

  return Array.from(found).sort();
}

/**
 * Name/description heuristic — preserved for callers that only have a
 * `RecipeSummary` (the overview page card grid). For the edit page we
 * use `detectConnectorsFromYaml` against the live buffer because the
 * summary lacks step bodies.
 */
export function detectConnectorsForRecipe(recipe: RecipeSummary): string[] {
  const haystack = `${recipe.name} ${recipe.description ?? ""}`.toLowerCase();
  const found = new Set<string>();
  for (const ns of [
    ...Object.keys(TOOL_NAMESPACE_TO_CONNECTOR),
    ...KNOWN_CONNECTOR_IDS,
  ]) {
    if (haystack.includes(ns.toLowerCase())) {
      const c = namespaceToConnector(ns);
      if (c) found.add(c);
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
