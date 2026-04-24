"use client";
import { useEffect, useState } from "react";
import { apiPath } from '@/lib/api';
import AddConnectionModal from "./AddConnectionModal";

interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
}

// Icon components — inline SVG, no external deps

function IconEnvelope() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect
        x="2"
        y="4"
        width="16"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2 7l8 5 8-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect
        x="2"
        y="4"
        width="16"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M6 2v4M14 2v4M2 9h16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconGitHub() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10 2a8 8 0 00-2.529 15.591c.4.074.546-.174.546-.386 0-.19-.007-.693-.01-1.36-2.226.483-2.695-1.073-2.695-1.073-.364-.924-.888-1.17-.888-1.17-.726-.496.055-.486.055-.486.803.056 1.226.824 1.226.824.713 1.221 1.872.869 2.328.664.072-.517.279-.869.508-1.069-1.776-.202-3.644-.888-3.644-3.953 0-.873.312-1.587.824-2.147-.083-.202-.357-1.016.078-2.117 0 0 .672-.215 2.2.82a7.67 7.67 0 012-.27c.679.003 1.363.092 2 .27 1.527-1.035 2.198-.82 2.198-.82.436 1.101.162 1.915.08 2.117.513.56.822 1.274.822 2.147 0 3.073-1.871 3.749-3.653 3.947.287.248.543.735.543 1.48 0 1.069-.01 1.932-.01 2.194 0 .214.144.463.55.385A8.001 8.001 0 0010 2z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconLinear() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M3.5 13.207L6.793 16.5l9.207-9.207-3.293-3.293L3.5 13.207z"
        fill="currentColor"
        opacity="0.5"
      />
      <path
        d="M3 11.5L8.5 17l-5.5-5.5zM9 3l8 8-8-8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M3.293 12.293l4.414 4.414L16.414 8l-4.414-4.414L3.293 12.293z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function IconSlack() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {/* Hash / pound — universally associated with Slack channels */}
      <path
        d="M7 3v14M13 3v14M3 7h14M3 13h14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSentry() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {/* Sentry-style diagonal eye/shield shape */}
      <path
        d="M10 2L2 16h6.5M10 2l8 14h-6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 16a8 8 0 008-8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconNotion() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {/* Simplified Notion "N" mark */}
      <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 6l6 8M7 6h3M13 14h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconConfluence() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Wave shape — Atlassian/Confluence wave mark */}
      <path d="M3 14c2-3 4-5 7-5s5 2 7-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 10c2-3 4-5 7-5s5 2 7-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconDatadog() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Simple dog/monitor shape */}
      <rect x="2" y="5" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 5V3M14 5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconHubspot() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Magnet / sprocket shape loosely evocative of HubSpot */}
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconIntercom() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Chat bubble */}
      <rect x="2" y="3" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 17l2-3h4l2 3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 8h8M6 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconStripe() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Credit card */}
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 8h16" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="11" width="4" height="2" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function IconZendesk() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Headset / support shape */}
      <path d="M4 10a6 6 0 0112 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="2" y="10" width="3" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="10" width="3" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17 15v1a3 3 0 01-3 3h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------------ providers

const PROVIDERS: {
  id: string;
  name: string;
  description: string;
  icon: React.ComponentType;
}[] = [
  {
    id: "gmail",
    name: "Gmail",
    description:
      "Read and triage your inbox. Patchwork agents can summarise threads, draft replies, and label messages.",
    icon: IconEnvelope,
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Read open issues and pull requests via GitHub's official MCP server. Agents surface blocking work items and review requests.",
    icon: IconGitHub,
  },
  {
    id: "linear",
    name: "Linear",
    description:
      "Read and manage issues. Agents can surface blocking work, summarise ticket context, and draft updates.",
    icon: IconLinear,
  },
  {
    id: "sentry",
    name: "Sentry",
    description:
      "Read issues and stack traces via Sentry's official MCP server. Agents can surface new errors and trace bugs to the commit that introduced them.",
    icon: IconSentry,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description:
      "View your schedule. Agents can summarise upcoming meetings in your morning brief.",
    icon: IconCalendar,
  },
  {
    id: "slack",
    name: "Slack",
    description:
      "Post messages and list channels. Agents can send summaries, alerts, and notifications to your workspace.",
    icon: IconSlack,
  },
  {
    id: "notion",
    name: "Notion",
    description:
      "Query databases, read pages, and create content. Agents can sync issues, append meeting notes, and search your knowledge base.",
    icon: IconNotion,
  },
  {
    id: "confluence",
    name: "Confluence",
    description:
      "Read and write Confluence pages and spaces. Agents can search your knowledge base, append meeting notes, and create documentation.",
    icon: IconConfluence,
  },
  {
    id: "datadog",
    name: "Datadog",
    description:
      "Query monitors, dashboards, and events. Agents can surface active alerts and correlate incidents with recent deployments.",
    icon: IconDatadog,
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description:
      "Read contacts, deals, and companies. Agents can surface CRM context, draft follow-ups, and log activity.",
    icon: IconHubspot,
  },
  {
    id: "intercom",
    name: "Intercom",
    description:
      "Read conversations and customer data. Agents can triage support threads and surface trending issues.",
    icon: IconIntercom,
  },
  {
    id: "stripe",
    name: "Stripe",
    description:
      "Read payment events, customers, and subscriptions. Agents can surface billing anomalies and subscription status.",
    icon: IconStripe,
  },
  {
    id: "zendesk",
    name: "Zendesk",
    description:
      "Read support tickets and customer context. Agents can triage issues, surface trends, and draft responses.",
    icon: IconZendesk,
  },
];

// ------------------------------------------------------------------ types

interface ConnectorCardProps {
  name: string;
  description: string;
  icon: React.ReactNode;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => Promise<{ ok: boolean; message?: string }>;
  loading: boolean;
}

// ------------------------------------------------------------------ card

function ConnectorCard({
  name,
  description,
  icon,
  status,
  lastSync,
  onConnect,
  onDisconnect,
  onTest,
  loading,
}: ConnectorCardProps) {
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
    // auto-clear after 4s
    setTimeout(() => setTestResult(null), 4000);
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        {/* Icon container */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--r-3)",
            background: "var(--bg-3)",
            border: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-1)",
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          {icon}
        </div>

        {/* Name + description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 4,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)" }}>
              {name}
            </span>
            <span
              className={`pill ${status === "connected" ? "ok" : status === "needs_reauth" ? "warn" : "muted"}`}
              title={status === "needs_reauth" ? "Token expired — reconnect to restore access" : undefined}
            >
              {status === "connected" ? (
                <>
                  <span className="pill-dot" />
                  Connected
                </>
              ) : status === "needs_reauth" ? (
                <>
                  <span className="pill-dot" />
                  Reconnect required
                </>
              ) : (
                "Not connected"
              )}
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5 }}>
            {description}
          </p>
          {status === "connected" && lastSync && (
            <p style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 6 }}>
              Last synced{" "}
              <time dateTime={lastSync}>
                {new Date(lastSync).toLocaleString()}
              </time>
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          {status === "connected" ? (
            <>
              <button
                type="button"
                className="btn sm"
                onClick={handleTest}
                disabled={testing || loading}
                aria-label={`Test ${name} connection`}
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button
                type="button"
                className="btn sm danger"
                onClick={onDisconnect}
                disabled={loading}
                aria-label={`Disconnect ${name}`}
              >
                {loading ? "…" : "Disconnect"}
              </button>
            </>
          ) : status === "needs_reauth" ? (
            <button
              type="button"
              className="btn sm warn"
              onClick={onConnect}
              disabled={loading}
              aria-label={`Reconnect ${name}`}
            >
              {loading ? "…" : "Reconnect"}
            </button>
          ) : (
            <button
              type="button"
              className="btn sm primary"
              onClick={onConnect}
              disabled={loading}
              aria-label={`Connect ${name}`}
            >
              {loading ? "…" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {/* Test result feedback */}
      {testResult && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 12,
            padding: "8px 12px",
            borderRadius: "var(--r-2)",
            fontSize: 12,
            background: testResult.ok ? "var(--ok-soft)" : "var(--err-soft)",
            color: testResult.ok ? "var(--ok)" : "var(--err)",
          }}
        >
          {testResult.ok
            ? testResult.message ?? "Connection is working."
            : testResult.message ?? "Test failed — check bridge logs."}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ placeholder

function PlaceholderCard({
  name,
  description,
  icon,
}: {
  name: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{ opacity: 0.5, pointerEvents: "none", userSelect: "none" }}
      aria-hidden="true"
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--r-3)",
            background: "var(--bg-3)",
            border: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-3)",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 4,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-1)" }}>
              {name}
            </span>
            <span className="pill muted">Coming soon</span>
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: 1.5 }}>
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ token-modal config (token-paste connectors)

interface TokenModalConfig {
  name: string;
  icon: React.ReactNode;
  instructions: React.ReactNode;
  placeholder: string;
  tokenKey: string; // JSON body key
}

const TOKEN_MODAL_CONNECTORS: Record<string, TokenModalConfig> = {
  github: {
    name: "GitHub",
    icon: <IconGitHub />,
    instructions: (
      <>
        Create a personal access token at{" "}
        <a href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          github.com/settings/tokens
        </a>
        . Grant <code>repo</code> and <code>read:org</code> scopes.
      </>
    ),
    placeholder: "ghp_…",
    tokenKey: "token",
  },
  linear: {
    name: "Linear",
    icon: <IconLinear />,
    instructions: (
      <>
        Create an API key in{" "}
        <a href="https://linear.app/settings/api" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Linear Settings → API
        </a>
        .
      </>
    ),
    placeholder: "lin_api_…",
    tokenKey: "token",
  },
  confluence: {
    name: "Confluence",
    icon: <IconConfluence />,
    instructions: (
      <>
        Generate an API token at{" "}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          id.atlassian.com/manage-profile/security/api-tokens
        </a>
        . Paste it below along with your Atlassian base URL (e.g. <code>https://your-org.atlassian.net</code>) — the bridge stores both.
      </>
    ),
    placeholder: "Atlassian API token",
    tokenKey: "token",
  },
  datadog: {
    name: "Datadog",
    icon: <IconDatadog />,
    instructions: (
      <>
        Create an API key in Datadog under{" "}
        <a href="https://app.datadoghq.com/organization-settings/api-keys" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Organization Settings → API Keys
        </a>
        .
      </>
    ),
    placeholder: "Datadog API key",
    tokenKey: "apiKey",
  },
  hubspot: {
    name: "HubSpot",
    icon: <IconHubspot />,
    instructions: (
      <>
        Create a private app in HubSpot and copy the access token from{" "}
        <a href="https://app.hubspot.com/private-apps" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          HubSpot → Private Apps
        </a>
        .
      </>
    ),
    placeholder: "HubSpot private app token",
    tokenKey: "token",
  },
  intercom: {
    name: "Intercom",
    icon: <IconIntercom />,
    instructions: (
      <>
        Generate an access token in{" "}
        <a href="https://app.intercom.com/a/apps/_/settings/keys" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Intercom Settings → Access Tokens
        </a>
        .
      </>
    ),
    placeholder: "Intercom access token",
    tokenKey: "token",
  },
  stripe: {
    name: "Stripe",
    icon: <IconStripe />,
    instructions: (
      <>
        Find your secret key in{" "}
        <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Stripe Dashboard → Developers → API Keys
        </a>
        . Use a restricted key with read-only permissions.
      </>
    ),
    placeholder: "sk_live_… or sk_test_…",
    tokenKey: "secretKey",
  },
  zendesk: {
    name: "Zendesk",
    icon: <IconZendesk />,
    instructions: (
      <>
        Generate an API token in{" "}
        <a href="https://support.zendesk.com/hc/en-us/articles/4408889192858" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Zendesk Admin Center → Apps and Integrations → APIs
        </a>
        . You will also need your subdomain and agent email.
      </>
    ),
    placeholder: "Zendesk API token",
    tokenKey: "token",
  },
};

// ------------------------------------------------------------------ page

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const [bridgeOffline, setBridgeOffline] = useState(false);
  // per-connector action loading state
  const [acting, setActing] = useState<string | null>(null);
  // inline action error
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Notion token-paste modal state
  const [notionModalOpen, setNotionModalOpen] = useState(false);
  const [notionToken, setNotionToken] = useState("");
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [notionErr, setNotionErr] = useState<string | null>(null);
  // Generic token modal (confluence, datadog, hubspot, intercom, stripe, zendesk)
  const [tokenModal, setTokenModal] = useState<string | null>(null); // connector id
  const [tokenValue, setTokenValue] = useState("");
  const [tokenConnecting, setTokenConnecting] = useState(false);
  const [tokenErr, setTokenErr] = useState<string | null>(null);

  async function fetchConnectors() {
    try {
      const res = await fetch(apiPath("/api/connections"));
      if (res.status >= 500) {
        setBridgeOffline(true);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`/api/connections ${res.status}`);
      const data = (await res.json()) as { connectors: ConnectorStatus[] };
      setConnectors(data.connectors ?? []);
      setBridgeOffline(false);
      setErr(undefined);
    } catch (e) {
      setBridgeOffline(true);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchConnectors();
  }, []);

  function getConnector(id: string): ConnectorStatus {
    return connectors.find((c) => c.id === id) ?? { id, status: "disconnected" };
  }

  async function handleNotionConnect() {
    if (!notionToken.startsWith("secret_")) {
      setNotionErr('Token must start with "secret_" — find it in Notion → Settings → Connections → Your integrations');
      return;
    }
    setNotionConnecting(true);
    setNotionErr(null);
    try {
      const res = await fetch(apiPath("/api/connections/notion/connect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: notionToken }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setNotionErr(body.error ?? `Error ${res.status}`);
        return;
      }
      setNotionToken("");
      setNotionModalOpen(false);
      await fetchConnectors();
    } catch (e) {
      setNotionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNotionConnecting(false);
    }
  }

  async function handleTokenConnect() {
    if (!tokenModal) return;
    setTokenConnecting(true);
    setTokenErr(null);
    const cfg = TOKEN_MODAL_CONNECTORS[tokenModal];
    try {
      const res = await fetch(apiPath(`/api/connections/${tokenModal}/connect`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [cfg.tokenKey]: tokenValue }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setTokenErr(body.error ?? `Error ${res.status}`);
        return;
      }
      setTokenValue("");
      setTokenModal(null);
      await fetchConnectors();
    } catch (e) {
      setTokenErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTokenConnecting(false);
    }
  }

  function handleConnect(id: string) {
    if (id === "notion") {
      setNotionModalOpen(true);
      setNotionErr(null);
      return;
    }
    if (id in TOKEN_MODAL_CONNECTORS) {
      setTokenModal(id);
      setTokenValue("");
      setTokenErr(null);
      return;
    }
    // Open the OAuth auth URL. Omit "noopener" so the callback page can
    // postMessage back to this window. Safe: same-origin popup.
    window.open(apiPath(`/api/connections/${id}/auth`), "_blank");
    // Poll for status update as fallback if postMessage doesn't arrive.
    const poll = setInterval(async () => {
      const res = await fetch(apiPath("/api/connections")).catch(() => null);
      if (!res) return;
      const data = (await res.json().catch(() => null)) as {
        connectors: ConnectorStatus[];
      } | null;
      if (!data) return;
      const updated = data.connectors.find((c) => c.id === id);
      if (updated?.status === "connected") {
        setConnectors(data.connectors);
        clearInterval(poll);
      }
    }, 3000);
    setTimeout(() => clearInterval(poll), 120_000);
  }

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (typeof e.data !== "string") return;
      const m = /^patchwork:([a-z-]+):connected$/.exec(e.data);
      if (!m) return;
      fetchConnectors();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function handleDisconnect(id: string) {
    setActing(id);
    setActionErr(null);
    try {
      const res = await fetch(apiPath(`/api/connections/${id}`), { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setActionErr(body.error ?? `Error ${res.status}`);
        return;
      }
      setConnectors((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "disconnected", lastSync: undefined } : c)),
      );
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  async function handleTest(id: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await fetch(apiPath(`/api/connections/${id}/test`), { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        return { ok: false, message: body.error ?? `Error ${res.status}` };
      }
      return { ok: body.ok !== false, message: body.message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }


  const hasAnyConnected = connectors.some(
    (c) => c.status === "connected" || c.status === "needs_reauth",
  );

  const [modalOpen, setModalOpen] = useState(false);

  function handleAddConnection() {
    setModalOpen(true);
  }

  const gmailConnector = getConnector("gmail");
  const githubConnector = getConnector("github");
  const linearConnector = getConnector("linear");
  const sentryConnector = getConnector("sentry");
  const calendarConnector = getConnector("google-calendar");
  const slackConnector = getConnector("slack");
  const confluenceConnector = getConnector("confluence");
  const datadogConnector = getConnector("datadog");
  const hubspotConnector = getConnector("hubspot");
  const intercomConnector = getConnector("intercom");
  const stripeConnector = getConnector("stripe");
  const zendeskConnector = getConnector("zendesk");

  const totalProviders = 13;
  const connectedCount = connectors.filter((c) => c.status === "connected").length;
  const degradedCount = connectors.filter((c) => c.status === "needs_reauth").length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <div className="page-head-sub">
            Link your accounts so Patchwork can act on your behalf.
          </div>
        </div>
        {!loading && !bridgeOffline && hasAnyConnected && (
          <button
            type="button"
            className="btn sm primary"
            onClick={handleAddConnection}
          >
            Add connection
          </button>
        )}
      </div>

      {!loading && !bridgeOffline && (
        <div
          className="card"
          style={{
            padding: "16px 22px",
            marginBottom: "var(--s-5)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-5)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: degradedCount > 0 ? "var(--warn)" : connectedCount > 0 ? "var(--ok)" : "var(--ink-3)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: degradedCount > 0 ? "var(--warn)" : connectedCount > 0 ? "var(--ok)" : "var(--ink-2)" }}>
              {degradedCount > 0 ? `${degradedCount} needs reconnect` : connectedCount > 0 ? "All healthy" : "No connections"}
            </span>
          </div>
          <div aria-hidden="true" style={{ width: 1, height: 28, background: "var(--line-2)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>{connectedCount}</div>
              <div style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 3, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Connected</div>
            </div>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: degradedCount > 0 ? "var(--warn)" : "var(--ink-0)", lineHeight: 1 }}>{degradedCount}</div>
              <div style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 3, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Degraded</div>
            </div>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: "var(--ink-0)", lineHeight: 1 }}>{totalProviders}</div>
              <div style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 3, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Available</div>
            </div>
          </div>
        </div>
      )}

      {err && (
        <div className="alert-err" role="alert">
          {err}
        </div>
      )}

      {actionErr && (
        <div className="alert-err" role="alert">
          {actionErr}
        </div>
      )}

      {bridgeOffline ? (
        <div className="empty-state" role="status">
          <h3>Bridge offline</h3>
          <p>
            The bridge is not running. Start it with{" "}
            <code>patchwork start-all</code> then reload this page.
          </p>
        </div>
      ) : loading ? (
        <div className="empty-state" role="status" aria-busy="true">
          <p>Loading…</p>
        </div>
      ) : (
        <>
          {!hasAnyConnected && (
            <div
              style={{
                textAlign: "center",
                padding: "var(--s-8) var(--s-6)",
                marginBottom: "var(--s-6)",
              }}
            >
              <p style={{ color: "var(--fg-2)", fontSize: 14, marginBottom: "var(--s-4)" }}>
                No connections yet. Add one to get started.
              </p>
              <button
                type="button"
                className="btn primary"
                onClick={handleAddConnection}
              >
                Add connection
              </button>
            </div>
          )}
          <div
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
          {/* Active connectors */}
          <ConnectorCard
            name="Gmail"
            description="Read and triage your inbox. Patchwork agents can summarise threads, draft replies, and label messages."
            icon={<IconEnvelope />}
            status={gmailConnector.status}
            lastSync={gmailConnector.lastSync}
            onConnect={() => handleConnect("gmail")}
            onDisconnect={() => handleDisconnect("gmail")}
            onTest={() => handleTest("gmail")}
            loading={acting === "gmail"}
          />

          <ConnectorCard
            name="GitHub"
            description="Read open issues and pull requests via GitHub's official MCP server. Agents surface blocking work items and review requests."
            icon={<IconGitHub />}
            status={githubConnector.status}
            lastSync={githubConnector.lastSync}
            onConnect={() => handleConnect("github")}
            onDisconnect={() => handleDisconnect("github")}
            onTest={() => handleTest("github")}
            loading={acting === "github"}
          />

          <ConnectorCard
            name="Linear"
            description="Read and manage issues. Agents can surface blocking work, summarise ticket context, and draft updates."
            icon={<IconLinear />}
            status={linearConnector.status}
            lastSync={linearConnector.lastSync}
            onConnect={() => handleConnect("linear")}
            onDisconnect={() => handleDisconnect("linear")}
            onTest={() => handleTest("linear")}
            loading={acting === "linear"}
          />

          <ConnectorCard
            name="Sentry"
            description="Read issues and stack traces via Sentry's official MCP server. Agents can surface new errors and trace bugs to the commit that introduced them."
            icon={<IconSentry />}
            status={sentryConnector.status}
            lastSync={sentryConnector.lastSync}
            onConnect={() => handleConnect("sentry")}
            onDisconnect={() => handleDisconnect("sentry")}
            onTest={() => handleTest("sentry")}
            loading={acting === "sentry"}
          />

          <ConnectorCard
            name="Google Calendar"
            description="View your schedule. Agents can summarise upcoming meetings in your morning brief."
            icon={<IconCalendar />}
            status={calendarConnector.status}
            lastSync={calendarConnector.lastSync}
            onConnect={() => handleConnect("google-calendar")}
            onDisconnect={() => handleDisconnect("google-calendar")}
            onTest={() => handleTest("google-calendar")}
            loading={acting === "google-calendar"}
          />
          <ConnectorCard
            name="Slack"
            description="Post messages and list channels. Agents can send summaries, alerts, and notifications to your workspace."
            icon={<IconSlack />}
            status={slackConnector.status}
            lastSync={slackConnector.lastSync}
            onConnect={() => handleConnect("slack")}
            onDisconnect={() => handleDisconnect("slack")}
            onTest={() => handleTest("slack")}
            loading={acting === "slack"}
          />
          <ConnectorCard
            name="Notion"
            description="Query databases, read pages, and create content. Agents can sync issues, append meeting notes, and search your knowledge base."
            icon={<IconNotion />}
            status={getConnector("notion").status}
            lastSync={getConnector("notion").lastSync}
            onConnect={() => handleConnect("notion")}
            onDisconnect={() => handleDisconnect("notion")}
            onTest={() => handleTest("notion")}
            loading={acting === "notion"}
          />
          <ConnectorCard
            name="Confluence"
            description="Read and write Confluence pages and spaces. Agents can search your knowledge base, append meeting notes, and create documentation."
            icon={<IconConfluence />}
            status={confluenceConnector.status}
            lastSync={confluenceConnector.lastSync}
            onConnect={() => handleConnect("confluence")}
            onDisconnect={() => handleDisconnect("confluence")}
            onTest={() => handleTest("confluence")}
            loading={acting === "confluence"}
          />
          <ConnectorCard
            name="Datadog"
            description="Query monitors, dashboards, and events. Agents can surface active alerts and correlate incidents with recent deployments."
            icon={<IconDatadog />}
            status={datadogConnector.status}
            lastSync={datadogConnector.lastSync}
            onConnect={() => handleConnect("datadog")}
            onDisconnect={() => handleDisconnect("datadog")}
            onTest={() => handleTest("datadog")}
            loading={acting === "datadog"}
          />
          <ConnectorCard
            name="HubSpot"
            description="Read contacts, deals, and companies. Agents can surface CRM context, draft follow-ups, and log activity."
            icon={<IconHubspot />}
            status={hubspotConnector.status}
            lastSync={hubspotConnector.lastSync}
            onConnect={() => handleConnect("hubspot")}
            onDisconnect={() => handleDisconnect("hubspot")}
            onTest={() => handleTest("hubspot")}
            loading={acting === "hubspot"}
          />
          <ConnectorCard
            name="Intercom"
            description="Read conversations and customer data. Agents can triage support threads and surface trending issues."
            icon={<IconIntercom />}
            status={intercomConnector.status}
            lastSync={intercomConnector.lastSync}
            onConnect={() => handleConnect("intercom")}
            onDisconnect={() => handleDisconnect("intercom")}
            onTest={() => handleTest("intercom")}
            loading={acting === "intercom"}
          />
          <ConnectorCard
            name="Stripe"
            description="Read payment events, customers, and subscriptions. Agents can surface billing anomalies and subscription status."
            icon={<IconStripe />}
            status={stripeConnector.status}
            lastSync={stripeConnector.lastSync}
            onConnect={() => handleConnect("stripe")}
            onDisconnect={() => handleDisconnect("stripe")}
            onTest={() => handleTest("stripe")}
            loading={acting === "stripe"}
          />
          <ConnectorCard
            name="Zendesk"
            description="Read support tickets and customer context. Agents can triage issues, surface trends, and draft responses."
            icon={<IconZendesk />}
            status={zendeskConnector.status}
            lastSync={zendeskConnector.lastSync}
            onConnect={() => handleConnect("zendesk")}
            onDisconnect={() => handleDisconnect("zendesk")}
            onTest={() => handleTest("zendesk")}
            loading={acting === "zendesk"}
          />
          </div>
        </>
      )}

      {/* Notion token-paste modal */}
      {notionModalOpen && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setNotionModalOpen(false); setNotionToken(""); setNotionErr(null); } }}
        >
          <div
            className="card"
            style={{ width: "100%", maxWidth: 420, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <IconNotion />
              <strong style={{ fontSize: 15 }}>Connect Notion</strong>
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-2)", margin: 0 }}>
              Create an internal integration at{" "}
              <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
                notion.so/my-integrations
              </a>
              , copy the integration token, and paste it below.
              Then share your databases/pages with the integration inside Notion.
            </p>
            <input
              type="password"
              autoFocus
              placeholder="secret_..."
              value={notionToken}
              onChange={(e) => setNotionToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleNotionConnect(); }}
              style={{
                fontFamily: "var(--font-mono)", fontSize: 13,
                padding: "8px 12px", borderRadius: 6,
                border: "1px solid var(--border-subtle)",
                background: "var(--bg-0)", color: "var(--fg-1)",
                width: "100%", boxSizing: "border-box",
              }}
            />
            {notionErr && (
              <div className="alert-err" style={{ fontSize: 12 }}>{notionErr}</div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setNotionModalOpen(false); setNotionToken(""); setNotionErr(null); }}
                style={{ padding: "6px 16px", fontSize: 13, cursor: "pointer", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--bg-1)", color: "var(--fg-1)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleNotionConnect()}
                disabled={notionConnecting || !notionToken}
                style={{ padding: "6px 16px", fontSize: 13, cursor: notionConnecting ? "wait" : "pointer", borderRadius: 6, border: "none", background: "var(--fg-1)", color: "var(--bg-0)", opacity: !notionToken ? 0.5 : 1 }}
              >
                {notionConnecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generic token-paste modal (confluence, datadog, hubspot, intercom, stripe, zendesk) */}
      {tokenModal && TOKEN_MODAL_CONNECTORS[tokenModal] && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setTokenModal(null);
              setTokenValue("");
              setTokenErr(null);
            }
          }}
        >
          <div
            className="card"
            style={{ width: "100%", maxWidth: 440, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {TOKEN_MODAL_CONNECTORS[tokenModal].icon}
              <strong style={{ fontSize: 15 }}>
                Connect {TOKEN_MODAL_CONNECTORS[tokenModal].name}
              </strong>
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-2)", margin: 0, lineHeight: 1.6 }}>
              {TOKEN_MODAL_CONNECTORS[tokenModal].instructions}
            </p>
            <input
              type="password"
              autoFocus
              placeholder={TOKEN_MODAL_CONNECTORS[tokenModal].placeholder}
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleTokenConnect(); }}
              style={{
                fontFamily: "var(--font-mono)", fontSize: 13,
                padding: "8px 12px", borderRadius: 6,
                border: "1px solid var(--border-subtle)",
                background: "var(--bg-0)", color: "var(--fg-1)",
                width: "100%", boxSizing: "border-box",
              }}
            />
            {tokenErr && (
              <div className="alert-err" style={{ fontSize: 12 }}>{tokenErr}</div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => { setTokenModal(null); setTokenValue(""); setTokenErr(null); }}
                style={{ padding: "6px 16px", fontSize: 13, cursor: "pointer", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--bg-1)", color: "var(--fg-1)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleTokenConnect()}
                disabled={tokenConnecting || !tokenValue.trim()}
                style={{ padding: "6px 16px", fontSize: 13, cursor: tokenConnecting ? "wait" : "pointer", borderRadius: 6, border: "none", background: "var(--fg-1)", color: "var(--bg-0)", opacity: !tokenValue.trim() ? 0.5 : 1 }}
              >
                {tokenConnecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}

      <AddConnectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        connectors={connectors}
        acting={acting}
        onConnect={handleConnect}
        providers={PROVIDERS}
      />
    </section>
  );
}
