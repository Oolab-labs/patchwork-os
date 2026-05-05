"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Skeleton, SkeletonText } from "@/components/Skeleton";
import { apiPath } from "@/lib/api";
import {
  assertValidInstallSource,
  type ApprovalBehavior,
  type RegistryData,
  type RegistryRecipe,
  type RiskLevel,
  shortName,
} from "@/lib/registry";

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
      risk_level: "low",
      network_access: true,
      file_access: false,
      approval_behavior: "ask_on_novel",
      maintainer: "@patchworkos",
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
      risk_level: "medium",
      network_access: true,
      file_access: false,
      approval_behavior: "always_ask",
      maintainer: "@patchworkos",
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
      risk_level: "low",
      network_access: true,
      file_access: false,
      approval_behavior: "ask_on_novel",
      maintainer: "@patchworkos",
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
      risk_level: "medium",
      network_access: true,
      file_access: false,
      approval_behavior: "always_ask",
      maintainer: "@patchworkos",
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
      risk_level: "low",
      network_access: true,
      file_access: false,
      approval_behavior: "ask_on_novel",
      maintainer: "@patchworkos",
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


// ------------------------------------------------------------------ trust metadata

const RISK_PILL_CLASS: Record<RiskLevel, string> = {
  low: "ok",
  medium: "warn",
  high: "err",
};

const APPROVAL_LABEL: Record<ApprovalBehavior, string> = {
  always_ask: "Always asks",
  ask_on_novel: "Asks on new",
  auto_approve: "Auto",
};

// ------------------------------------------------------------------ helpers

function connectorInitials(id: string): string {
  const norm = id.toLowerCase().replace(/[^a-z]/g, "");
  if (norm === "googlecalendar" || norm === "calendar") return "GC";
  return norm.slice(0, 2).toUpperCase();
}

function connectorColor(id: string): string {
  const norm = id.toLowerCase().replace(/[^a-z]/g, "");
  return PROVIDER_COLORS[norm] ?? "#4a5568";
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
        boxShadow: "0 8px 32px var(--overlay-bg)",
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

  return (
    <div className="template-card glass-card">
      {/* top: name */}
      <div style={{ marginBottom: "var(--s-2)" }}>
        <Link
          href={`/marketplace/${recipe.name}`}
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--fg-0)",
            wordBreak: "break-word",
            lineHeight: 1.4,
            textDecoration: "none",
          }}
          aria-label={`View details for ${shortName(recipe.name)}`}
        >
          {shortName(recipe.name)}
        </Link>
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

      {/* trust metadata badges */}
      {(recipe.risk_level || recipe.approval_behavior || recipe.network_access || recipe.file_access) && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: "var(--s-2)" }}>
          {recipe.risk_level && (
            <span
              className={`pill ${RISK_PILL_CLASS[recipe.risk_level]}`}
              style={{ fontSize: 9 }}
              title={`Risk level: ${recipe.risk_level}`}
            >
              {recipe.risk_level} risk
            </span>
          )}
          {recipe.approval_behavior && (
            <span
              className="pill muted"
              style={{ fontSize: 9 }}
              title={`Approval: ${recipe.approval_behavior}`}
            >
              {APPROVAL_LABEL[recipe.approval_behavior]}
            </span>
          )}
          {recipe.network_access && (
            <span className="pill muted" style={{ fontSize: 9 }} title="Makes outbound network requests">
              network
            </span>
          )}
          {recipe.file_access && (
            <span className="pill muted" style={{ fontSize: 9 }} title="Reads or writes local files">
              file I/O
            </span>
          )}
        </div>
      )}

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
          {recipe.downloads > 0 && (
            <span
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                marginLeft: 2,
              }}
              title={`${recipe.downloads.toLocaleString()} installs`}
            >
              ↓ {recipe.downloads >= 1000
                ? `${(recipe.downloads / 1000).toFixed(1)}k`
                : recipe.downloads}
            </span>
          )}
        </div>

        <div style={{ flexShrink: 0 }}>
          {isInstalled ? (
            <span
              className="pill"
              style={{
                background: "var(--ok-soft)",
                color: "var(--ok)",
                border: "1px solid var(--ok)",
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
              href="https://patchworkos.com/#install"
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
  const [searchOpen, setSearchOpen] = useState(false);
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

      // Fetch registry: bridge → raw GitHub → hardcoded fallback. Each
      // hop has a 4s timeout so a slow CDN can't keep the user staring
      // at a skeleton.
      const fetchWithTimeout = (url: string, ms: number) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), ms);
        return fetch(url, { signal: ctl.signal }).finally(() =>
          clearTimeout(timer),
        );
      };

      let recipes: RegistryRecipe[] | null = null;

      try {
        const res = await fetchWithTimeout(apiPath("/api/bridge/templates"), 4000);
        if (res.ok) {
          const data = (await res.json()) as { recipes?: RegistryRecipe[] } | RegistryRecipe[];
          recipes = Array.isArray(data)
            ? data
            : Array.isArray(data?.recipes)
              ? (data.recipes ?? null)
              : null;
        }
      } catch {
        // bridge offline / timed out — try GitHub
      }

      if (!recipes) {
        try {
          const res = await fetchWithTimeout(
            "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json",
            4000,
          );
          if (res.ok) {
            const data = (await res.json()) as RegistryData;
            recipes = data.recipes ?? null;
          }
        } catch {
          // GitHub also failed / timed out — use hardcoded fallback
        }
      }

      setRegistry(recipes ?? FALLBACK_REGISTRY.recipes);
    }

    load().catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleInstall(recipe: RegistryRecipe) {
    // Defense in depth: refuse to forward anything that isn't a github:owner/repo[/path]@ref
    // shape. The bridge also validates server-side; this blocks the obvious tampered-registry
    // attack at the dashboard layer before the request leaves the browser.
    try {
      assertValidInstallSource(recipe.install);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `This recipe's install source is invalid (${detail}). Refusing to install.`,
      );
    }
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
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q)) ||
      r.connectors.some((c) => c.toLowerCase().includes(q))
    );
  });

  const isSearching = search.trim().length > 0;
  const featured = isSearching ? undefined : filtered[0];
  const rest = isSearching ? filtered : filtered.slice(1);
  const totalVisible = filtered.length;

  return (
    <section>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* offline banner */}
      {!bridgeOnline && (
        <div
          style={{
            marginBottom: "var(--s-6)",
            padding: "12px 16px",
            background: "var(--purple-soft)",
            border: "1px solid var(--purple)",
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
            href="https://patchworkos.com/#install"
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
              border: "1px solid var(--purple)",
              textDecoration: "none",
            }}
          >
            Install →
          </a>
        </div>
      )}

      <div className="page-head">
        <div>
          <h1 className="editorial-h1">
            Marketplace — <span className="accent">recipes built by the community.</span>
          </h1>
          <div className="editorial-sub">
            {`${registry?.length ?? FALLBACK_REGISTRY.recipes.length} recipes · open-source YAML · audited weekly`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className="btn sm ghost"
            style={{ fontSize: 12 }}
            aria-label="Toggle search"
            aria-expanded={searchOpen}
          >
            Search
          </button>
          <a
            href="https://github.com/patchworkos/recipes/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noopener noreferrer"
            className="btn sm"
            style={{ textDecoration: "none", fontSize: 12 }}
            aria-label="Submit a recipe to the marketplace"
          >
            + Submit recipe
          </a>
        </div>
      </div>

      {searchOpen && (
        <div style={{ marginBottom: "var(--s-6)" }}>
          <input
            type="search"
            className="input"
            placeholder="Search by name, tags, connectors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 360 }}
            aria-label="Search marketplace"
            autoFocus
          />
        </div>
      )}

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
      ) : totalVisible === 0 ? (
        <div className="empty-state">
          <h3>No results found</h3>
          <p>Try a different search term or category.</p>
        </div>
      ) : (
        <>
          {featured && (
            <>
              <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-2)", marginBottom: "var(--s-3)", marginTop: 0 }}>
                Featured this week
              </h2>
              <div
                className="marketplace-grid"
                style={{
                  gridTemplateColumns: "1fr",
                  marginBottom: "var(--s-8)",
                }}
              >
                <div
                  style={{
                    border: "1px solid var(--accent)",
                    borderRadius: "var(--r-3)",
                    background: "var(--accent-soft)",
                    padding: 2,
                    position: "relative",
                  }}
                >
                  <span
                    className="pill"
                    style={{
                      position: "absolute",
                      top: 12,
                      right: 12,
                      zIndex: 2,
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      letterSpacing: "0.06em",
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      border: "1px solid var(--accent-tint)",
                    }}
                  >
                    ★ FEATURED
                  </span>
                  <RecipeCard
                    key={featured.name}
                    recipe={featured}
                    installed={installedNames.has(featured.name)}
                    bridgeOnline={bridgeOnline}
                    onInstall={handleInstall}
                  />
                </div>
              </div>
            </>
          )}

          {rest.length > 0 && (
            <>
              <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-2)", marginBottom: "var(--s-3)", marginTop: 0 }}>
                All recipes
              </h2>
              <div className="marketplace-grid">
                {rest.map((recipe) => (
                  <RecipeCard
                    key={recipe.name}
                    recipe={recipe}
                    installed={installedNames.has(recipe.name)}
                    bridgeOnline={bridgeOnline}
                    onInstall={handleInstall}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
