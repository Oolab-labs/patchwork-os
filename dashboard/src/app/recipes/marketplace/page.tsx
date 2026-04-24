"use client";
import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api";

// ------------------------------------------------------------------ types

interface RegistryRecipe {
  name: string;
  version: string;
  description: string;
  tags: string[];
  connectors: string[];
  install: string;
  downloads: number;
}

interface RegistryData {
  version: string;
  updated_at: string;
  recipes: RegistryRecipe[];
}

// ------------------------------------------------------------------ fallback data

const FALLBACK_REGISTRY: RegistryData = {
  version: "1",
  updated_at: "2026-04-24T00:00:00Z",
  recipes: [
    {
      name: "@patchworkos/morning-brief",
      version: "1.0.0",
      description:
        "Daily 6am digest: Gmail unread, Linear assigned issues, Slack DMs, and today's calendar — composed into one Slack message.",
      tags: ["productivity", "morning", "daily"],
      connectors: ["gmail", "linear", "slack", "calendar"],
      install: "github:patchworkos/recipes/recipes/morning-brief",
      downloads: 0,
    },
    {
      name: "@patchworkos/incident-war-room",
      version: "1.0.0",
      description:
        "Ops incident response: summarize alert, open Linear issue, post to #incidents Slack, then append post-incident summary to Notion.",
      tags: ["ops", "incident", "on-call"],
      connectors: ["linear", "slack", "notion"],
      install: "github:patchworkos/recipes/recipes/incident-war-room",
      downloads: 0,
    },
    {
      name: "@patchworkos/sprint-review-prep",
      version: "1.0.0",
      description:
        "Pull completed Linear issues for the current sprint, summarize with AI, post digest to #engineering Slack channel.",
      tags: ["engineering", "sprint"],
      connectors: ["linear", "slack"],
      install: "github:patchworkos/recipes/recipes/sprint-review-prep",
      downloads: 0,
    },
    {
      name: "@patchworkos/customer-escalation",
      version: "1.0.0",
      description:
        "Zendesk ticket escalation pipeline: fetch ticket, create linked Linear issue, alert #support-escalations on Slack.",
      tags: ["support", "escalation"],
      connectors: ["zendesk", "linear", "slack"],
      install: "github:patchworkos/recipes/recipes/customer-escalation",
      downloads: 0,
    },
    {
      name: "@patchworkos/deal-won-celebration",
      version: "1.0.0",
      description:
        "HubSpot deal closed-won trigger: celebrate in #wins Slack, log deal details to a Notion database.",
      tags: ["sales", "hubspot", "crm"],
      connectors: ["hubspot", "slack", "notion"],
      install: "github:patchworkos/recipes/recipes/deal-won-celebration",
      downloads: 0,
    },
  ],
};

// ------------------------------------------------------------------ constants

const PROVIDER_COLORS: Record<string, string> = {
  gmail: "#EA4335",
  slack: "#4A154B",
  linear: "#5E6AD2",
  github: "#24292E",
  notion: "#000000",
  calendar: "#4285F4",
  googlecalendar: "#4285F4",
  jira: "#0052CC",
  confluence: "#0052CC",
  zendesk: "#03363D",
  intercom: "#1F8EEF",
  hubspot: "#FF7A59",
  datadog: "#632CA6",
  stripe: "#635BFF",
  sentry: "#362D59",
  pagerduty: "#06AC38",
};

const CATEGORIES = ["All", "Productivity", "Incident Ops", "Engineering", "Customer", "Sales"];

const CATEGORY_TAG_MAP: Record<string, string[]> = {
  Productivity: ["productivity", "morning", "daily"],
  "Incident Ops": ["ops", "incident", "on-call"],
  Engineering: ["engineering", "sprint"],
  Customer: ["support", "escalation", "zendesk", "intercom"],
  Sales: ["sales", "hubspot", "crm"],
};

// ------------------------------------------------------------------ helpers

function shortName(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

function connectorInitials(id: string): string {
  const norm = id.toLowerCase().replace(/[^a-z]/g, "");
  if (norm === "googlecalendar" || norm === "calendar") return "GC";
  return norm.slice(0, 2).toUpperCase();
}

function connectorColor(id: string): string {
  const norm = id.toLowerCase().replace(/[^a-z]/g, "");
  return PROVIDER_COLORS[norm] ?? "#4a5568";
}

function recipeMatchesCategory(recipe: RegistryRecipe, category: string): boolean {
  if (category === "All") return true;
  const allowed = CATEGORY_TAG_MAP[category] ?? [];
  return recipe.tags.some((t) => allowed.includes(t.toLowerCase()));
}

// ------------------------------------------------------------------ toast

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDone, 3000);
    return () => clearTimeout(id);
  }, [onDone]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        background: "var(--bg-3)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--r-3)",
        padding: "12px 18px",
        fontSize: 13,
        color: "var(--fg-0)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span style={{ color: "var(--ok)", fontSize: 16 }}>&#10003;</span>
      {message}
    </div>
  );
}

// ------------------------------------------------------------------ card

function TemplateCard({
  recipe,
  installed,
  onInstall,
}: {
  recipe: RegistryRecipe;
  installed: boolean;
  onInstall: (recipe: RegistryRecipe) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState(false);

  const isInstalled = installed || justInstalled;

  async function handleInstall() {
    setLoading(true);
    setErr(null);
    try {
      await onInstall(recipe);
      setJustInstalled(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const displayTags = recipe.tags.slice(0, 2);

  return (
    <div className="template-card glass-card">
      {/* top: name + tags */}
      <div style={{ marginBottom: "var(--s-2)" }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--fg-0)",
            marginBottom: "var(--s-2)",
            wordBreak: "break-word",
          }}
        >
          {shortName(recipe.name)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {displayTags.map((tag) => (
            <span key={tag} className="tag-pill">
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* middle: description */}
      <p
        style={{
          fontSize: 12,
          color: "var(--fg-2)",
          lineHeight: 1.55,
          flex: 1,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          margin: 0,
        }}
      >
        {recipe.description}
      </p>

      {/* bottom: connectors + install */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: "var(--s-3)",
          gap: "var(--s-2)",
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {recipe.connectors.map((c) => (
            <span
              key={c}
              className="connector-dot"
              title={c}
              style={{ background: connectorColor(c) }}
              aria-label={c}
            >
              {connectorInitials(c)}
            </span>
          ))}
        </div>

        <div style={{ flexShrink: 0 }}>
          {isInstalled ? (
            <span
              className="pill"
              style={{
                background: "var(--ok-soft)",
                color: "var(--ok)",
                border: "1px solid rgba(52,211,153,0.2)",
                fontSize: 11,
              }}
            >
              &#10003; Installed
            </span>
          ) : (
            <button
              type="button"
              className="btn sm"
              onClick={handleInstall}
              disabled={loading}
              aria-label={`Install ${shortName(recipe.name)}`}
            >
              {loading ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </div>

      {/* inline error */}
      {err && (
        <div
          style={{
            marginTop: "var(--s-2)",
            fontSize: 11,
            color: "var(--err)",
            lineHeight: 1.5,
          }}
          role="alert"
        >
          {err}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function MarketplacePage() {
  const [registry, setRegistry] = useState<RegistryRecipe[] | null>(null);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      // Fetch installed recipes in parallel
      const installedPromise = fetch(apiPath("/api/bridge/recipes"))
        .then(async (r) => {
          if (!r.ok) return [];
          const data = await r.json();
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data?.recipes)
              ? data.recipes
              : [];
          return list.map((r: { name: string }) => r.name) as string[];
        })
        .catch(() => [] as string[]);

      // Fetch registry: bridge → raw GitHub → hardcoded fallback
      let recipes: RegistryRecipe[] | null = null;

      try {
        const res = await fetch(apiPath("/api/bridge/templates"));
        if (res.ok) {
          const data = (await res.json()) as { recipes?: RegistryRecipe[] } | RegistryRecipe[];
          recipes = Array.isArray(data)
            ? data
            : Array.isArray(data?.recipes)
              ? (data.recipes ?? null)
              : null;
        }
      } catch {
        // bridge fetch failed — try GitHub
      }

      if (!recipes) {
        try {
          const res = await fetch(
            "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json",
          );
          if (res.ok) {
            const data = (await res.json()) as RegistryData;
            recipes = data.recipes ?? null;
          }
        } catch {
          // GitHub also failed — use hardcoded fallback
        }
      }

      if (!recipes) {
        recipes = FALLBACK_REGISTRY.recipes;
      }

      const installed = await installedPromise;
      setInstalledNames(new Set(installed));
      setRegistry(recipes);
    }

    load().catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleInstall(recipe: RegistryRecipe) {
    const res = await fetch(apiPath("/api/bridge/recipes/install"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: recipe.install }),
    });

    if (res.status === 404 || res.status === 501) {
      throw new Error("Install requires bridge v0.2.0-alpha.26+");
    }

    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        // ignore parse failure
      }
      throw new Error(msg);
    }

    setInstalledNames((prev) => new Set([...prev, recipe.name]));
    setToast("Recipe installed successfully");
  }

  const filtered = (registry ?? []).filter((r) => {
    const matchesCategory = recipeMatchesCategory(r, category);
    if (!matchesCategory) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <section>
      {toast && (
        <Toast
          message={toast}
          onDone={() => setToast(null)}
        />
      )}

      <div className="page-head">
        <div>
          <h1>Marketplace</h1>
          <div className="page-head-sub">Community recipes for Patchwork OS</div>
        </div>
        {registry && (
          <span className="pill muted">{filtered.length} recipe{filtered.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* search + category filters */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
          marginBottom: "var(--s-6)",
        }}
      >
        <input
          type="search"
          className="input"
          placeholder="Search recipes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 360 }}
          aria-label="Search marketplace recipes"
        />

        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              style={{
                padding: "4px 14px",
                borderRadius: "var(--r-full)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                border: "1px solid",
                transition: "all 0.15s",
                borderColor:
                  category === cat ? "var(--accent)" : "var(--border-default)",
                background:
                  category === cat ? "var(--accent-soft)" : "transparent",
                color: category === cat ? "var(--accent-strong)" : "var(--fg-2)",
              }}
              aria-pressed={category === cat}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {loadErr && (
        <div className="alert-err" role="alert" style={{ marginBottom: "var(--s-4)" }}>
          {loadErr}
        </div>
      )}

      {registry === null && !loadErr ? (
        <div className="empty-state" role="status" aria-busy="true">
          <p>Loading marketplace…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h3>No recipes found</h3>
          <p>Try a different search term or category.</p>
        </div>
      ) : (
        <div className="marketplace-grid">
          {filtered.map((recipe) => (
            <TemplateCard
              key={recipe.name}
              recipe={recipe}
              installed={installedNames.has(recipe.name)}
              onInstall={handleInstall}
            />
          ))}
        </div>
      )}
    </section>
  );
}
