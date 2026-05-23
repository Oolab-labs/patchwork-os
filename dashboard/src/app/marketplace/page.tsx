"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Skeleton, SkeletonText } from "@/components/Skeleton";
import { EmptyState, HintCard } from "@/components/patchwork";
import { canonicalRecipeKey } from "@/lib/entityKey";
import { InstallConfirmDialog } from "./_components/InstallConfirmDialog";
import { apiPath } from "@/lib/api";
import {
  assertValidInstallSource,
  type ApprovalBehavior,
  formatConnectorLabel,
  normalizeConnectorId,
  type RegistryBundle,
  type RegistryData,
  type RegistryRecipe,
  type RiskLevel,
  shortName,
} from "@/lib/registry";
import { useToast } from "@/components/Toast";

// ------------------------------------------------------------------ fallback data (shown when bridge offline)

// Snapshot of the live registry at `raw.githubusercontent.com/patchworkos/
// recipes/main/index.json`, with trust metadata layered in (the live
// JSON doesn't carry `risk_level` / `network_access` etc. yet — Wave 0
// fixes the dialog gate to default-deny in their absence; this fallback
// fills them in for the offline read-view UX). Refresh when new recipes
// land in the live registry.
const FALLBACK_REGISTRY: RegistryData = {
  version: "1",
  updated_at: "2026-05-23T00:00:00Z",
  recipes: [
    {
      name: "@patchworkos/morning-brief",
      version: "1.0.0",
      description:
        "Daily 6am digest: Gmail unread, Linear assigned issues, Slack DMs, and today's calendar — composed into one Slack message.",
      tags: ["productivity", "morning", "daily"],
      connectors: ["gmail", "linear", "slack", "google-calendar"],
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
    {
      name: "@patchworkos/end-of-day-shutdown",
      version: "1.0.0",
      description:
        "Weekday 6pm shutdown digest: open Linear issues, unread Slack DMs, and tomorrow's calendar — composed into a 4-line Slack message.",
      tags: ["productivity", "evening", "daily"],
      connectors: ["linear", "slack", "google-calendar"],
      install: "github:patchworkos/recipes/recipes/end-of-day-shutdown",
      downloads: 0,
      risk_level: "low",
      network_access: true,
      file_access: false,
      approval_behavior: "ask_on_novel",
      maintainer: "@patchworkos",
    },
    {
      name: "@patchworkos/standup-digest",
      version: "1.0.0",
      description:
        "Weekday 9am standup post: yesterday's closed Linear issues plus today's in-progress work, composed into a 3-line yesterday/today/blockers update for Slack.",
      tags: ["engineering", "daily", "standup"],
      connectors: ["linear", "slack"],
      install: "github:patchworkos/recipes/recipes/standup-digest",
      downloads: 0,
      risk_level: "low",
      network_access: true,
      file_access: false,
      approval_behavior: "ask_on_novel",
      maintainer: "@patchworkos",
    },
    {
      name: "@patchworkos/friday-recap",
      version: "1.0.0",
      description:
        "Friday 4pm weekly recap: closed Linear issues, calendar load, and active Slack threads — composed into a wins/losses summary posted to Slack and optionally appended to a Notion weekly log.",
      tags: ["engineering", "weekly", "recap"],
      connectors: ["linear", "slack", "google-calendar", "notion"],
      install: "github:patchworkos/recipes/recipes/friday-recap",
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


// ------------------------------------------------------------------ card

function RecipeCard({
  recipe,
  installed,
  bridgeStatus,
  onInstall,
}: {
  recipe: RegistryRecipe;
  installed: boolean;
  bridgeStatus: BridgeStatus;
  onInstall: (recipe: RegistryRecipe) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isInstalled = installed || justInstalled;

  // Risk-aware confirmation. Low-risk recipes install on a single click
  // (preserves the existing one-click flow); medium/high or any recipe
  // that requests network/file access opens a styled summary dialog so
  // the operator sees what they're agreeing to before the bridge fetches it.
  const elevated =
    recipe.risk_level === "medium" ||
    recipe.risk_level === "high" ||
    recipe.network_access ||
    recipe.file_access;

  async function runInstall() {
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

  function handleInstall() {
    if (elevated) {
      setConfirmOpen(true);
      return;
    }
    void runInstall();
  }

  return (
    <div className="template-card glass-card">
      {/* top: name + maintainer attribution */}
      <div style={{ marginBottom: "var(--s-2)" }}>
        <Link
          href={`/marketplace/${recipe.name}`}
          style={{
            fontWeight: 600,
            fontSize: "var(--fs-base)",
            color: "var(--fg-0)",
            wordBreak: "break-word",
            lineHeight: 1.4,
            textDecoration: "none",
          }}
          aria-label={`View details for ${shortName(recipe.name)}`}
        >
          {shortName(recipe.name)}
        </Link>
        {recipe.maintainer && (
          <div
            style={{
              fontSize: "var(--fs-xs)",
              color: "var(--ink-3)",
              marginTop: 2,
            }}
          >
            by {recipe.maintainer}
          </div>
        )}
      </div>

      {/* middle: description */}
      <p
        style={{
          fontSize: "var(--fs-s)",
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
              style={{ fontSize: "var(--fs-2xs)" }}
              title={`Risk level: ${recipe.risk_level}`}
            >
              {recipe.risk_level} risk
            </span>
          )}
          {recipe.approval_behavior && (
            <span
              className="pill muted"
              style={{ fontSize: "var(--fs-2xs)" }}
              title={`Approval: ${recipe.approval_behavior}`}
            >
              {APPROVAL_LABEL[recipe.approval_behavior]}
            </span>
          )}
          {recipe.network_access && (
            <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }} title="Makes outbound network requests">
              network
            </span>
          )}
          {recipe.file_access && (
            <span className="pill muted" style={{ fontSize: "var(--fs-2xs)" }} title="Reads or writes local files">
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
          {recipe.connectors.map((rawId) => {
            // Wave 1: normalize legacy connector-id spellings (the live
            // registry uses `googleCalendar`; older fallback data uses
            // `calendar`; canonical is `google-calendar`). Without this
            // the chip dot rendered grey with garbage initials.
            const c = normalizeConnectorId(rawId);
            return (
            <span
              key={c}
              className="connector-dot"
              title={c}
              style={{ background: connectorColor(c) }}
              aria-label={c}
            >
              {connectorInitials(c)}
            </span>
            );
          })}
          {recipe.downloads > 0 && (
            <span
              style={{
                fontSize: "var(--fs-xs)",
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
            <Link
              href={`/recipes/${canonicalRecipeKey(recipe.name)}`}
              className="pill"
              style={{
                background: "var(--ok-soft)",
                color: "var(--ok)",
                border: "1px solid var(--ok)",
                fontSize: "var(--fs-xs)",
                textDecoration: "none",
              }}
              title="Open installed recipe"
            >
              &#10003; Installed
            </Link>
          ) : bridgeStatus === "online" ? (
            <button
              type="button"
              className="btn sm primary"
              onClick={handleInstall}
              disabled={loading}
              aria-label={`Install ${shortName(recipe.name)}`}
            >
              {loading ? "Installing…" : "Install"}
            </button>
          ) : bridgeStatus === "unauth" ? (
            <Link
              href={`/login?next=${encodeURIComponent(`/dashboard/marketplace/${recipe.name}`)}`}
              className="btn sm"
              style={{ textDecoration: "none" }}
              aria-label={`Log in to install ${shortName(recipe.name)}`}
            >
              Log in
            </Link>
          ) : bridgeStatus === "offline" ? (
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
          ) : (
            // bridgeStatus === "checking" — render no action while the
            // first probe is in flight; switching to a real CTA happens
            // when refreshInstalled resolves.
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 84,
                height: 28,
              }}
            />
          )}
        </div>
      </div>

      {/* inline error */}
      {err && (
        <div
          style={{
            marginTop: "var(--s-2)",
            fontSize: "var(--fs-xs)",
            color: "var(--err)",
            lineHeight: 1.5,
          }}
          role="alert"
        >
          {err}
        </div>
      )}

      <InstallConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void runInstall()}
        name={shortName(recipe.name)}
        source={recipe.install}
        riskLevel={recipe.risk_level}
        connectors={recipe.connectors}
        networkAccess={recipe.network_access}
        fileAccess={recipe.file_access}
      />
    </div>
  );
}

// ------------------------------------------------------------------ bundle card

function BundleCard({ bundle }: { bundle: RegistryBundle }) {
  const href = `/marketplace/bundle/${encodeURIComponent(bundle.name)}`;
  return (
    <Link
      href={href}
      style={{ textDecoration: "none" }}
      className="template-card glass-card"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "18px 18px 16px", height: "100%" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-xs)",
              fontWeight: 600,
              color: "var(--accent)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {shortName(bundle.name)}
          </span>
          <span className="pill info" style={{ fontSize: "var(--fs-2xs)", flexShrink: 0 }}>bundle</span>
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-m)", color: "var(--ink-1)", lineHeight: 1.5 }}>
          {bundle.description}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: "auto" }}>
          {bundle.connectors.slice(0, 4).map((c) => (
            <span key={c} className="pill" style={{ fontSize: "var(--fs-2xs)" }}>{c}</span>
          ))}
          {bundle.connectors.length > 4 && (
            <span className="pill" style={{ fontSize: "var(--fs-2xs)", color: "var(--ink-3)" }}>+{bundle.connectors.length - 4}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: "var(--fs-xs)", color: "var(--ink-3)", marginTop: 4 }}>
          {bundle.recipe_count != null && <span>{bundle.recipe_count} recipes</span>}
          {bundle.has_plugin && <span>+ plugin</span>}
          {bundle.has_policy && <span>+ policy</span>}
        </div>
      </div>
    </Link>
  );
}

// ------------------------------------------------------------------ page

// "checking" is the initial state before the first probe completes —
// hides the "Install Patchwork OS" banner during page-load instead of
// flashing it on slow networks (~4s+ on 3G). Matches InstallPanel.tsx.
type BridgeStatus = "checking" | "online" | "offline" | "unauth";

export default function MarketplacePage() {
  const [registry, setRegistry] = useState<RegistryRecipe[] | null>(null);
  const [bundles, setBundles] = useState<RegistryBundle[]>([]);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  // Three-state instead of boolean — distinguishes 401 (logged-out
  // dashboard, bridge IS reachable) from 503 (bridge truly down).
  // Pre-fix users were told "bridge not connected — install Patchwork
  // OS" when they were just logged out of the dashboard.
  const [bridgeStatus, setBridgeStatus] =
    useState<BridgeStatus>("checking");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const toast = useToast();
  const router = useRouter();

  // Re-probe bridge + refresh the installed-names Set. Extracted so the
  // post-install handler can call it after install (the bridge writes
  // recipes under the YAML `name:` field, which may differ from the
  // marketplace's scoped `@scope/name` — without a refresh the
  // "Installed" pill can lag a render).
  const refreshInstalled = useCallback(async () => {
    try {
      const r = await fetch(apiPath("/api/bridge/recipes"));
      if (!r.ok) {
        // 401 = dashboard's session-cookie middleware blocked the proxy
        // (user logged out). The bridge itself may be fine. Everything
        // else (404 from no-bridge-lock, 502/503 from upstream) means
        // the bridge is genuinely unreachable.
        setBridgeStatus(r.status === 401 ? "unauth" : "offline");
        return;
      }
      const data = await r.json();
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.recipes)
          ? data.recipes
          : [];
      setBridgeStatus("online");
      setInstalledNames(new Set(list.map((r: { name: string }) => shortName(r.name))));
    } catch {
      setBridgeStatus("offline");
    }
  }, []);

  useEffect(() => {
    async function load() {
      await refreshInstalled();

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
      let registryBundles: RegistryBundle[] = [];

      try {
        const res = await fetchWithTimeout(apiPath("/api/bridge/templates"), 4000);
        if (res.ok) {
          const data = (await res.json()) as { recipes?: RegistryRecipe[]; bundles?: RegistryBundle[] } | RegistryRecipe[];
          recipes = Array.isArray(data)
            ? data
            : Array.isArray(data?.recipes)
              ? (data.recipes ?? null)
              : null;
          if (!Array.isArray(data) && Array.isArray(data?.bundles)) {
            registryBundles = data.bundles ?? [];
          }
        }
      } catch {
        // bridge offline / timed out — try GitHub
      }

      // Audit 2026-05-17 (#600): bridge can return an empty registry
      // (recipes: []) on a fresh install before any recipes are seeded.
      // The original guard `if (!recipes)` short-circuited on truthy
      // empty array → user saw "no recipes available" indefinitely
      // even though GitHub has the seed set. Treat empty array as a
      // miss too so the GitHub fallback runs.
      if (!recipes || recipes.length === 0) {
        try {
          const res = await fetchWithTimeout(
            "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json",
            4000,
          );
          if (res.ok) {
            const data = (await res.json()) as RegistryData;
            recipes = data.recipes ?? null;
            registryBundles = data.bundles ?? [];
          }
        } catch {
          // GitHub also failed / timed out — use hardcoded fallback
        }
      }

      if (recipes && recipes.length > 0) {
        setRegistry(recipes);
        setBundles(registryBundles);
      } else {
        // Both bridge and GitHub failed — show the hardcoded fallback BUT
        // surface the failure so users know they're looking at stale,
        // pre-seeded data rather than live registry contents.
        setRegistry(FALLBACK_REGISTRY.recipes);
        setBundles(registryBundles);
        setLoadErr("registry unreachable — showing built-in fallback");
      }
    }

    load().catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));

    // Refresh the installed set every 30s so recipes installed via CLI or
    // another tab show the "Installed" badge without a manual reload.
    const pollId = setInterval(() => {
      void refreshInstalled();
    }, 30_000);

    // Wave 2 fix (item 12): re-fetch the registry every 5 min so a long-
    // lived tab picks up new recipes added to GitHub. Previously the
    // registry was fetched ONCE on mount — a tab opened during a brief
    // GitHub outage would show the FALLBACK_REGISTRY for its entire
    // lifetime, or a tab open all day during a registry add would
    // never see the new recipe. 5 min matches the bridge's templates
    // cache TTL — anything faster would hit the cache anyway.
    const registryPollId = setInterval(() => {
      void load().catch(() => {
        // swallow — fall through to whatever we had; setLoadErr was
        // already wired on the initial load. A revalidation failure
        // shouldn't flip a working catalog into an error state.
      });
    }, 5 * 60_000);

    return () => {
      clearInterval(pollId);
      clearInterval(registryPollId);
    };
  // refreshInstalled is stable (useCallback with no deps)
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Parse the response body once — both success and failure paths need it.
    let parsed: {
      ok?: boolean;
      error?: string;
      missingConnectors?: string[];
    } = {};
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      // ignore parse failure — fall back to status-only error below
    }

    if (!res.ok) {
      // 502 / 503 / 504 from our Next.js proxy means the bridge stopped
      // responding to bridgeFetch — flip the offline banner so the next
      // click renders "Get Patchwork" instead of another opaque retry,
      // and surface a friendlier message than the raw upstream body.
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        setBridgeStatus("offline");
        throw new Error(
          "Bridge isn't responding. Start it with `patchwork start` and try again.",
        );
      }
      if (res.status === 401) {
        setBridgeStatus("unauth");
        throw new Error(
          "Dashboard session expired. Log in and try again.",
        );
      }
      throw new Error(parsed.error ?? `Error ${res.status}`);
    }

    // Optimistic update so the card flips to "Installed" immediately.
    // installedNames is keyed by the unscoped name (what the bridge's
    // /recipes endpoint returns) — strip the `@scope/` prefix so the
    // Set lookup at the card-render sites matches.
    setInstalledNames((prev) => new Set([...prev, shortName(recipe.name)]));
    const recipeKey = canonicalRecipeKey(recipe.name);
    toast.success(`Installed ${shortName(recipe.name)}`, {
      action: {
        label: "View in Recipes",
        onClick: () => router.push(`/recipes/${recipeKey}`),
      },
    });
    // Authoritative refresh from the bridge re-reads the unscoped names
    // from disk — keep the Set in sync in case the actual YAML `name:`
    // field differs from the slug the user clicked.
    void refreshInstalled();

    // Bridge-side connector preflight (#488) ships a `missingConnectors`
    // array when the recipe uses connectors the user hasn't authorised
    // yet. Surface as a follow-up warn toast with an action link to
    // /connections — non-blocking, can be dismissed, but tells the user
    // exactly what they need to do before this recipe will run.
    const missing = Array.isArray(parsed.missingConnectors)
      ? parsed.missingConnectors.filter(
          (c): c is string => typeof c === "string",
        )
      : [];
    if (missing.length > 0) {
      const labels = missing.slice(0, 3).map(formatConnectorLabel);
      const overflow = missing.length - labels.length;
      const list =
        overflow > 0
          ? `${labels.join(", ")} + ${overflow} more`
          : labels.join(", ");
      toast.warn(`Connect ${list} before this recipe can run.`, {
        duration: 8000,
        action: {
          label: "Open connections",
          onClick: () => {
            router.push("/connections");
          },
        },
      });
    }
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
      {/* status banner — distinct copy + CTA for "logged out" (bridge
          may be fine) vs "no bridge" (Install Patchwork). Pre-fix both
          collapsed into the "Install Patchwork" CTA, which told logged-
          out users to reinstall a thing they already had. */}
      {bridgeStatus !== "online" && bridgeStatus !== "checking" && (
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
            fontSize: "var(--fs-m)",
          }}
        >
          <span style={{ color: "var(--fg-2)" }}>
            {bridgeStatus === "unauth"
              ? "Browsing as a guest — log in to install recipes directly."
              : "Browsing in preview mode — bridge not connected. Install Patchwork OS to install recipes directly."}
          </span>
          {bridgeStatus === "unauth" ? (
            <Link
              href="/login?next=/dashboard/marketplace"
              style={{
                flexShrink: 0,
                fontSize: "var(--fs-s)",
                fontWeight: 600,
                padding: "4px 14px",
                borderRadius: "var(--r-full)",
                background: "var(--accent-soft)",
                color: "var(--accent-strong)",
                border: "1px solid var(--purple)",
                textDecoration: "none",
              }}
            >
              Log in →
            </Link>
          ) : (
            <a
              href="https://patchworkos.com/#install"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                flexShrink: 0,
                fontSize: "var(--fs-s)",
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
          )}
        </div>
      )}

      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 className="editorial-h1" style={{ margin: 0 }}>
              Marketplace — <span className="accent">open-source YAML, curated.</span>
            </h1>
            <HintCard.Toggle id="marketplace" />
          </div>
          <div className="editorial-sub">
            {`${registry?.length ?? FALLBACK_REGISTRY.recipes.length} recipes · sourced from github.com/patchworkos/recipes`}
          </div>
        </div>
        {/* flex-wrap so Search + Submit drop below the title on narrow
            viewports instead of squeezing the heading; flex-shrink:0 on
            the action chips so they don't compress past their text width. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className="btn sm ghost"
            style={{ fontSize: "var(--fs-s)", flexShrink: 0 }}
            aria-label="Toggle search"
            aria-expanded={searchOpen}
          >
            Search
          </button>
          <Link
            href="/marketplace/submit"
            className="btn sm primary"
            style={{
              textDecoration: "none",
              fontSize: "var(--fs-s)",
              flexShrink: 0,
            }}
            title="Compose a recipe and open a PR against patchworkos/recipes via GitHub's web flow."
          >
            Submit a recipe
          </Link>
        </div>
      </div>

      <HintCard id="marketplace" />

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
        <EmptyState
          title="No results found"
          description="Try a different search term or category."
        />
      ) : (
        <>
          {bundles.length > 0 && (
            <>
              <h2 style={{ fontSize: "var(--fs-m)", fontWeight: 600, color: "var(--fg-2)", marginBottom: "var(--s-3)", marginTop: 0 }}>
                Capability bundles
              </h2>
              <p style={{ fontSize: "var(--fs-s)", color: "var(--ink-2)", marginBottom: "var(--s-4)", marginTop: "calc(-1 * var(--s-2))" }}>
                Recipes + connectors + policy templates — install as one unit.
              </p>
              <div className="marketplace-grid" style={{ marginBottom: "var(--s-8)" }}>
                {bundles.map((b) => <BundleCard key={b.name} bundle={b} />)}
              </div>
            </>
          )}

          {featured && (
            <>
              <h2 style={{ fontSize: "var(--fs-m)", fontWeight: 600, color: "var(--fg-2)", marginBottom: "var(--s-3)", marginTop: 0 }}>
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
                      fontSize: "var(--fs-2xs)",
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
                    installed={installedNames.has(shortName(featured.name))}
                    bridgeStatus={bridgeStatus}
                    onInstall={handleInstall}
                  />
                </div>
              </div>
            </>
          )}

          {rest.length > 0 && (
            <>
              <h2 style={{ fontSize: "var(--fs-m)", fontWeight: 600, color: "var(--fg-2)", marginBottom: "var(--s-3)", marginTop: 0 }}>
                All recipes
              </h2>
              <div className="marketplace-grid">
                {rest.map((recipe) => (
                  <RecipeCard
                    key={recipe.name}
                    recipe={recipe}
                    installed={installedNames.has(shortName(recipe.name))}
                    bridgeStatus={bridgeStatus}
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
