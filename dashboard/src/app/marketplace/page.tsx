"use client";
import { useEffect, useState } from "react";
import { Skeleton, SkeletonText } from "@/components/Skeleton";
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

// ------------------------------------------------------------------ fallback data (shown when bridge offline)

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

function RecipeCard({
  recipe,
  installed,
  bridgeOnline,
  onInstall,
}: {
  recipe: RegistryRecipe;
  installed: boolean;
  bridgeOnline: boolean;
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
          WebkitLineClamp: 3,
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
          ) : bridgeOnline ? (
            <button
              type="button"
              className="btn sm"
              onClick={handleInstall}
              disabled={loading}
              aria-label={`Install ${shortName(recipe.name)}`}
            >
              {loading ? "Installing…" : "Install"}
            </button>
          ) : (
            <a
              href="https://github.com/Oolab-labs/claude-ide-bridge#installation"
              target="_blank"
              rel="noopener noreferrer"
              className="btn sm"
              style={{ textDecoration: "none" }}
              aria-label={`Get Patchwork to install ${shortName(recipe.name)}`}
            >
              Get Patchwork
            </a>
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
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      // Check bridge + fetch installed in parallel
      const [installedResult] = await Promise.allSettled([
        fetch(apiPath("/api/bridge/recipes")).then(async (r) => {
          if (!r.ok) return { online: false, names: [] as string[] };
          const data = await r.json();
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data?.recipes)
              ? data.recipes
              : [];
          return { online: true, names: list.map((r: { name: string }) => r.name) as string[] };
        }),
      ]);

      if (installedResult.status === "fulfilled") {
        setBridgeOnline(installedResult.value.online);
        setInstalledNames(new Set(installedResult.value.names));
      }

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
        // bridge offline — try GitHub
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

      setRegistry(recipes ?? FALLBACK_REGISTRY.recipes);
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
    if (!recipeMatchesCategory(r, category)) return false;
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
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* offline banner */}
      {!bridgeOnline && (
        <div
          style={{
            marginBottom: "var(--s-6)",
            padding: "12px 16px",
            background: "rgba(99,102,241,0.06)",
            border: "1px solid rgba(99,102,241,0.18)",
            borderRadius: "var(--r-3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--fg-2)" }}>
            Browsing in preview mode — bridge not connected. Install Patchwork OS to install recipes directly.
          </span>
          <a
            href="https://github.com/Oolab-labs/claude-ide-bridge#installation"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 600,
              padding: "4px 14px",
              borderRadius: "var(--r-full)",
              background: "var(--accent-soft)",
              color: "var(--accent-strong)",
              border: "1px solid rgba(99,102,241,0.25)",
              textDecoration: "none",
            }}
          >
            Install →
          </a>
        </div>
      )}

      <div className="page-head">
        <div>
          <h1>Marketplace</h1>
          <div className="page-head-sub">Community recipes for Patchwork OS</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 12px",
              borderRadius: "var(--r-full)",
              fontSize: 12,
              fontWeight: 600,
              background: "rgba(216,119,87,0.12)",
              color: "var(--orange)",
              border: "1px solid rgba(216,119,87,0.25)",
              letterSpacing: "0.04em",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--orange)",
                display: "inline-block",
                animation: "pulse 2s infinite",
              }}
            />
            Coming soon
          </span>
          {registry && (
            <span className="pill muted">
              {filtered.length} recipe{filtered.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
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
                borderColor: category === cat ? "var(--accent)" : "var(--border-default)",
                background: category === cat ? "var(--accent-soft)" : "transparent",
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
        <div className="marketplace-grid" role="status" aria-busy="true" aria-label="Loading recipes">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <div key={i} className="template-card glass-card" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "18px 18px 16px" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <Skeleton width={20} height={20} style={{ borderRadius: 4, flexShrink: 0 }} />
                <SkeletonText width="60%" />
              </div>
              <SkeletonText width="90%" />
              <SkeletonText width="75%" size="sm" />
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <Skeleton width={40} height={18} style={{ borderRadius: 20 }} />
                <Skeleton width={50} height={18} style={{ borderRadius: 20 }} />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h3>No recipes found</h3>
          <p>Try a different search term or category.</p>
        </div>
      ) : (
        <div className="marketplace-grid">
          {filtered.map((recipe) => (
            <RecipeCard
              key={recipe.name}
              recipe={recipe}
              installed={installedNames.has(recipe.name)}
              bridgeOnline={bridgeOnline}
              onInstall={handleInstall}
            />
          ))}
        </div>
      )}
    </section>
  );
}
