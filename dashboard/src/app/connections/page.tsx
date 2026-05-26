"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import AddConnectionModal from "./AddConnectionModal";
import { YourConnectorRequests } from "./YourConnectorRequests";
import { Dialog } from "@/components/Dialog";
import { EmptyState, HintCard, RelationStrip } from "@/components/patchwork";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import type { ConnectorStatus } from "./types";

// ------------------------------------------------------------------ helpers

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// ------------------------------------------------------------------ catalog

interface ConnectorDef {
  id: string;
  name: string;
  initials: string;
  category: string;
  wave: 1 | 2 | 3;
  tools: number;
  bg: string;
}

const CATALOG: ConnectorDef[] = [
  // Wave 1
  { id: "jira",             name: "Jira",             initials: "JI", category: "Project",    wave: 1, tools: 8,  bg: "#0052CC" },
  { id: "notion",           name: "Notion",           initials: "NO", category: "Docs",       wave: 1, tools: 6,  bg: "#000000" },
  { id: "pagerduty",        name: "PagerDuty",        initials: "PD", category: "Ops",        wave: 1, tools: 7,  bg: "#06AC38" },
  { id: "google-docs",      name: "Google Docs",      initials: "DO", category: "Docs",       wave: 1, tools: 2,  bg: "#4285F4" },
  { id: "confluence",       name: "Confluence",       initials: "CF", category: "Docs",       wave: 1, tools: 5,  bg: "#0052CC" },
  { id: "linear",           name: "Linear",           initials: "LI", category: "Project",    wave: 1, tools: 6,  bg: "#5E6AD2" },
  { id: "slack",            name: "Slack",            initials: "SL", category: "Comms",      wave: 1, tools: 7,  bg: "#4A154B" },
  { id: "discord",          name: "Discord",          initials: "DC", category: "Comms",      wave: 1, tools: 6,  bg: "#5865F2" },
  // Wave 2
  { id: "zendesk",          name: "Zendesk",          initials: "ZD", category: "Support",    wave: 2, tools: 6,  bg: "#03363D" },
  { id: "github",           name: "GitHub",           initials: "GH", category: "Dev",        wave: 2, tools: 10, bg: "#24292E" },
  { id: "gitlab",           name: "GitLab",           initials: "GL", category: "Dev",        wave: 2, tools: 9,  bg: "#FC6D26" },
  { id: "asana",            name: "Asana",            initials: "AS", category: "Project",    wave: 2, tools: 7,  bg: "#F06A6A" },
  { id: "monday",           name: "Monday",           initials: "MN", category: "Project",    wave: 2, tools: 6,  bg: "#FF3D57" },
  { id: "hubspot",          name: "HubSpot",          initials: "HS", category: "CRM",        wave: 2, tools: 8,  bg: "#FF7A59" },
  { id: "salesforce",       name: "Salesforce",       initials: "SF", category: "CRM",        wave: 2, tools: 9,  bg: "#00A1E0" },
  { id: "intercom",         name: "Intercom",         initials: "IC", category: "Support",    wave: 2, tools: 5,  bg: "#1F8EEF" },
  // Wave 3
  { id: "gmail",            name: "Gmail",            initials: "GM", category: "Email",      wave: 3, tools: 5,  bg: "#EA4335" },
  { id: "google-calendar",  name: "Google Calendar",  initials: "GC", category: "Calendar",   wave: 3, tools: 4,  bg: "#4285F4" },
  { id: "google-drive",     name: "Google Drive",     initials: "GD", category: "Files",      wave: 3, tools: 4,  bg: "#4285F4" },
  { id: "datadog",          name: "Datadog",          initials: "DD", category: "Monitoring", wave: 3, tools: 6,  bg: "#632CA6" },
  { id: "stripe",           name: "Stripe",           initials: "ST", category: "Payments",   wave: 3, tools: 7,  bg: "#635BFF" },
  { id: "sentry",           name: "Sentry",           initials: "SE", category: "Monitoring", wave: 3, tools: 5,  bg: "#362D59" },
  { id: "figma",            name: "Figma",            initials: "FG", category: "Design",     wave: 3, tools: 4,  bg: "#F24E1E" },
  { id: "airtable",         name: "Airtable",         initials: "AT", category: "Docs",       wave: 3, tools: 5,  bg: "#18BFFF" },
  { id: "webflow",          name: "Webflow",          initials: "WF", category: "Dev",        wave: 3, tools: 4,  bg: "#146EF5" },
  { id: "shopify",          name: "Shopify",          initials: "SH", category: "Commerce",   wave: 3, tools: 6,  bg: "#96BF48" },
  { id: "twilio",           name: "Twilio",           initials: "TW", category: "Comms",      wave: 3, tools: 4,  bg: "#F22F46" },
  { id: "sendgrid",         name: "SendGrid",         initials: "SG", category: "Email",      wave: 3, tools: 3,  bg: "#1A82E2" },
  { id: "snowflake",        name: "Snowflake",        initials: "SW", category: "Data",       wave: 3, tools: 5,  bg: "#29B5E8" },
  { id: "postgres",         name: "Postgres",         initials: "PG", category: "Data",       wave: 3, tools: 4,  bg: "#336791" },
  { id: "mongodb",          name: "MongoDB",          initials: "MG", category: "Data",       wave: 3, tools: 4,  bg: "#47A248" },
  { id: "redis",            name: "Redis",            initials: "RD", category: "Data",       wave: 3, tools: 3,  bg: "#DC382D" },
  { id: "elasticsearch",    name: "Elasticsearch",    initials: "ES", category: "Data",       wave: 3, tools: 4,  bg: "#FEC514" },
];


// ------------------------------------------------------------------ OAuth scope hints (per connector — surface what we requested)

const CONNECTOR_SCOPES: Record<string, string[]> = {
  slack:            ["channels:read", "chat:write", "users:read"],
  jira:             ["read:jira", "write:jira"],
  confluence:       ["read:confluence", "write:confluence"],
  github:           ["repo:read", "issues:read", "pulls:read"],
  gitlab:           ["read_api", "read_repository"],
  linear:           ["read", "write"],
  asana:            ["tasks:read", "projects:read"],
  notion:           ["read_content", "update_content"],
  discord:          ["messages.read", "guilds.read"],
  zendesk:          ["tickets:read", "users:read"],
  intercom:         ["conversations:read", "users:read"],
  hubspot:          ["contacts:read", "deals:read"],
  pagerduty:        ["incidents:read", "services:read"],
  datadog:          ["monitors_read", "events_read"],
  stripe:           ["read_only"],
  sentry:           ["event:read", "project:read"],
  gmail:            ["gmail.readonly"],
  "google-calendar":["calendar.readonly"],
  "google-drive":   ["drive.readonly"],
};

// ------------------------------------------------------------------ icon SVG components (kept for modals)

function IconEnvelope() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 7l8 5 8-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="2" y="4" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 2v4M14 2v4M2 9h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconGitHub() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M10 2a8 8 0 00-2.529 15.591c.4.074.546-.174.546-.386 0-.19-.007-.693-.01-1.36-2.226.483-2.695-1.073-2.695-1.073-.364-.924-.888-1.17-.888-1.17-.726-.496.055-.486.055-.486.803.056 1.226.824 1.226.824.713 1.221 1.872.869 2.328.664.072-.517.279-.869.508-1.069-1.776-.202-3.644-.888-3.644-3.953 0-.873.312-1.587.824-2.147-.083-.202-.357-1.016.078-2.117 0 0 .672-.215 2.2.82a7.67 7.67 0 012-.27c.679.003 1.363.092 2 .27 1.527-1.035 2.198-.82 2.198-.82.436 1.101.162 1.915.08 2.117.513.56.822 1.274.822 2.147 0 3.073-1.871 3.749-3.653 3.947.287.248.543.735.543 1.48 0 1.069-.01 1.932-.01 2.194 0 .214.144.463.55.385A8.001 8.001 0 0010 2z" fill="currentColor" />
    </svg>
  );
}

function IconGitlab() {
  // Stylized geometric mark — three triangles converging on a center line.
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M10 17l-7-9 2-5 2 5h6l2-5 2 5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 17L7 8M10 17l3-9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconLinear() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M3.5 13.207L6.793 16.5l9.207-9.207-3.293-3.293L3.5 13.207z" fill="currentColor" opacity="0.5" />
      <path d="M3.293 12.293l4.414 4.414L16.414 8l-4.414-4.414L3.293 12.293z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function IconSlack() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M7 3v14M13 3v14M3 7h14M3 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconNotion() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 6l6 8M7 6h3M13 14h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAsana() {
  // Asana brand mark — three dots arranged in a triangle (top, bottom-left, bottom-right).
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <circle cx="10" cy="6" r="2.5" fill="currentColor" />
      <circle cx="5.5" cy="13" r="2.5" fill="currentColor" />
      <circle cx="14.5" cy="13" r="2.5" fill="currentColor" />
    </svg>
  );
}

function IconConfluence() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M3 14c2-3 4-5 7-5s5 2 7-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 10c2-3 4-5 7-5s5 2 7-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconDiscord() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="2" y="4" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" />
      <circle cx="12.5" cy="10" r="1" fill="currentColor" />
      <path d="M5 16l1.5 2M15 16l-1.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconJira() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M10 3l7 7-7 7-7-7 7-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 7l3 3-3 3-3-3 3-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconDatadog() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="2" y="5" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 5V3M14 5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconHubspot() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconPagerduty() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M10 2a4 4 0 00-4 4v3a3 3 0 01-1.5 2.6L3 13h14l-1.5-1.4A3 3 0 0114 9V6a4 4 0 00-4-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 16a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconIntercom() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="2" y="3" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 17l2-3h4l2 3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 8h8M6 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconStripe() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 8h16" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="11" width="4" height="2" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function IconZendesk() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <path d="M4 10a6 6 0 0112 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="2" y="10" width="3" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="10" width="3" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17 15v1a3 3 0 01-3 3h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconDatabase() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <ellipse cx="10" cy="5" rx="6" ry="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 5v5c0 1.1 2.7 2 6 2s6-.9 6-2V5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 10v5c0 1.1 2.7 2 6 2s6-.9 6-2v-5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="conn-icon-svg">
      <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------------ token modal config

interface TokenModalConfig {
  name: string;
  icon: React.ReactNode;
  instructions: React.ReactNode;
  placeholder: string;
  tokenKey: string;
  extraFields?: { key: string; label: string; placeholder: string; type?: "text" | "email" | "url"; required?: boolean }[];
}

// Connectors that have a backend wired in the bridge — anything not listed
// here renders as "Coming Soon" in the catalog regardless of wave.
const SUPPORTED_CONNECTORS = new Set([
  "asana",
  "gmail",
  "google-calendar",
  "google-drive",
  "github",
  "gitlab",
  "linear",
  "sentry",
  "slack",
  "discord",
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
  "google-docs",
  "monday",
  "salesforce",
  "shopify",
  "snowflake",
]);

const TOKEN_MODAL_CONNECTORS: Record<string, TokenModalConfig> = {
  confluence: {
    name: "Confluence",
    icon: <IconConfluence />,
    instructions: (
      <>
        Generate an API token at{" "}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="conn-modal-link">
          id.atlassian.com/manage-profile/security/api-tokens
        </a>
        . Paste it below along with your Atlassian base URL (e.g. <code>https://your-org.atlassian.net</code>) — the bridge stores both.
      </>
    ),
    placeholder: "Atlassian API token",
    tokenKey: "token",
    extraFields: [
      { key: "baseUrl", label: "Atlassian base URL", placeholder: "https://your-org.atlassian.net", type: "url", required: true },
    ],
  },
  datadog: {
    name: "Datadog",
    icon: <IconDatadog />,
    instructions: (
      <>
        Create an API key in Datadog under{" "}
        <a href="https://app.datadoghq.com/organization-settings/api-keys" target="_blank" rel="noreferrer" className="conn-modal-link">
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
        <a href="https://app.hubspot.com/private-apps" target="_blank" rel="noreferrer" className="conn-modal-link">
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
        <a href="https://app.intercom.com/a/apps/_/settings/keys" target="_blank" rel="noreferrer" className="conn-modal-link">
          Intercom Settings → Access Tokens
        </a>
        .
      </>
    ),
    placeholder: "Intercom access token",
    tokenKey: "token",
  },
  jira: {
    name: "Jira",
    icon: <IconJira />,
    instructions: (
      <>
        Generate an API token at{" "}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="conn-modal-link">
          id.atlassian.com/manage-profile/security/api-tokens
        </a>
        . Paste it below along with your Atlassian base URL (e.g. <code>https://your-org.atlassian.net</code>) and your Atlassian account email — the bridge stores all three.
      </>
    ),
    placeholder: "Atlassian API token",
    tokenKey: "token",
    extraFields: [
      { key: "baseUrl", label: "Atlassian base URL", placeholder: "https://your-org.atlassian.net", type: "url", required: true },
      { key: "email", label: "Atlassian account email", placeholder: "you@your-org.com", type: "email", required: true },
    ],
  },
  pagerduty: {
    name: "PagerDuty",
    icon: <IconPagerduty />,
    instructions: (
      <>
        Generate a personal or general API access key in{" "}
        <a href="https://support.pagerduty.com/docs/api-access-keys" target="_blank" rel="noreferrer" className="conn-modal-link">
          PagerDuty → Integrations → API Access Keys
        </a>
        . Read-only keys are sufficient for this PR&apos;s incident, service, and on-call queries.
      </>
    ),
    placeholder: "PagerDuty API key",
    tokenKey: "token",
  },
  stripe: {
    name: "Stripe",
    icon: <IconStripe />,
    instructions: (
      <>
        Find your secret key in{" "}
        <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer" className="conn-modal-link">
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
        <a href="https://support.zendesk.com/hc/en-us/articles/4408889192858" target="_blank" rel="noreferrer" className="conn-modal-link">
          Zendesk Admin Center → Apps and Integrations → APIs
        </a>
        . You will also need your subdomain and agent email.
      </>
    ),
    placeholder: "Zendesk API token",
    tokenKey: "token",
    extraFields: [
      { key: "subdomain", label: "Zendesk subdomain", placeholder: "your-org", type: "text", required: true },
      { key: "email", label: "Agent email", placeholder: "you@your-org.com", type: "email", required: true },
    ],
  },
  postgres: {
    name: "Postgres",
    icon: <IconDatabase />,
    instructions: (
      <>
        Paste a Postgres connection string. The bridge validates by running <code>SELECT 1</code> before storing.
        Read-only credentials recommended — only SELECT/SHOW/EXPLAIN are accepted at query time.
        Requires <code>npm install pg</code> in the bridge install (lazy-loaded; bridge does not bundle the driver).
      </>
    ),
    placeholder: "postgres://user:pass@host:5432/dbname",
    tokenKey: "connectionString",
  },
  mongodb: {
    name: "MongoDB",
    icon: <IconDatabase />,
    instructions: (
      <>
        Paste a MongoDB connection URI. The bridge validates via <code>admin.ping</code> before storing.
        Read-only credentials recommended — write/aggregation operators like <code>$where</code>, <code>$out</code>,
        and <code>$merge</code> are rejected at query time.
        Requires <code>npm install mongodb</code> in the bridge install.
      </>
    ),
    placeholder: "mongodb+srv://user:pass@cluster.example.net/dbname",
    tokenKey: "connectionString",
  },
  redis: {
    name: "Redis",
    icon: <IconDatabase />,
    instructions: (
      <>
        Paste a Redis URL. The bridge validates via <code>PING</code> before storing.
        Read-only commands only — SET/DEL/FLUSHDB/CONFIG/EVAL etc. are rejected at the allowlist.
        Use <code>rediss://</code> for TLS. Requires <code>npm install redis</code> in the bridge install.
      </>
    ),
    placeholder: "redis://default:password@host:6379/0",
    tokenKey: "url",
  },
  elasticsearch: {
    name: "Elasticsearch",
    icon: <IconSearch />,
    instructions: (
      <>
        Either a node URL + API key, or an Elastic Cloud ID + API key. The bridge validates via <code>cluster.ping</code>
        before storing. Read-only — <code>script</code>/<code>script_fields</code> are rejected; size capped at 100.
        Requires <code>npm install @elastic/elasticsearch</code> in the bridge install.
      </>
    ),
    placeholder: "https://your-cluster.example.es.io:9243",
    tokenKey: "node",
    extraFields: [
      { key: "apiKey", label: "API key (base64 id:secret)", placeholder: "VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6...", type: "text", required: false },
      { key: "cloudId", label: "Elastic Cloud ID (alternative to node URL)", placeholder: "deployment:dXMtZWFzdC0xLmF3cy5l...", type: "text", required: false },
    ],
  },
  sendgrid: {
    name: "SendGrid",
    icon: <IconEnvelope />,
    instructions: (
      <>
        Create an API key in{" "}
        <a href="https://app.sendgrid.com/settings/api_keys" target="_blank" rel="noreferrer" className="conn-modal-link">
          SendGrid → Settings → API Keys
        </a>
        . Restricted-access keys with Mail Send + Templates read are enough.
        Optionally set a verified sender email so the <code>send</code> tool can
        default the From address.
      </>
    ),
    placeholder: "SendGrid API key (starts with SG.)",
    tokenKey: "apiKey",
    extraFields: [
      { key: "fromEmail", label: "Default sender email (optional)", placeholder: "you@your-org.com", type: "email", required: false },
    ],
  },
  twilio: {
    name: "Twilio",
    icon: <IconEnvelope />,
    instructions: (
      <>
        Find your Account SID + Auth Token in{" "}
        <a href="https://console.twilio.com/" target="_blank" rel="noreferrer" className="conn-modal-link">
          Twilio Console
        </a>
        . Add a default From number (E.164, e.g. <code>+15551234567</code>) so
        the <code>sendSms</code> tool can default it.
      </>
    ),
    placeholder: "Twilio Account SID (starts with AC)",
    tokenKey: "accountSid",
    extraFields: [
      { key: "authToken", label: "Auth token", placeholder: "Twilio auth token", type: "text", required: true },
      { key: "defaultFrom", label: "Default From number (E.164, optional)", placeholder: "+15551234567", type: "text", required: false },
    ],
  },
  figma: {
    name: "Figma",
    icon: <IconDatabase />,
    instructions: (
      <>
        Generate a Personal Access Token at{" "}
        <a href="https://www.figma.com/settings" target="_blank" rel="noreferrer" className="conn-modal-link">
          Figma → Settings → Personal access tokens
        </a>
        . Read-only by default — Figma&apos;s API surface is mostly read.
      </>
    ),
    placeholder: "Figma personal access token (starts with figd_)",
    tokenKey: "accessToken",
  },
  airtable: {
    name: "Airtable",
    icon: <IconDatabase />,
    instructions: (
      <>
        Create a Personal Access Token at{" "}
        <a href="https://airtable.com/create/tokens" target="_blank" rel="noreferrer" className="conn-modal-link">
          Airtable → Developer hub → Personal access tokens
        </a>
        . Grant <code>data.records:read</code> for read tools, plus
        <code> data.records:write</code> if you want create/update tools.
        Scope to specific bases for safety.
      </>
    ),
    placeholder: "Airtable personal access token (starts with pat)",
    tokenKey: "accessToken",
  },
  webflow: {
    name: "Webflow",
    icon: <IconDatabase />,
    instructions: (
      <>
        Create a Site API Token in{" "}
        <a href="https://webflow.com/dashboard/account/integrations" target="_blank" rel="noreferrer" className="conn-modal-link">
          Webflow → Account → Integrations → API access
        </a>
        . Webflow v2 tokens are scoped to one site — the connector captures
        the first site at connect time.
      </>
    ),
    placeholder: "Webflow site API token",
    tokenKey: "accessToken",
  },
  shopify: {
    name: "Shopify",
    icon: <IconDatabase />,
    instructions: (
      <>
        Create a Custom App in your Shopify admin under{" "}
        <a href="https://admin.shopify.com/settings/apps/development" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Settings → Apps and sales channels → Develop apps
        </a>
        . Grant <code>read_products</code>, <code>read_orders</code>, and
        <code> read_customers</code> Admin API scopes; install the app; copy
        the Admin API access token (starts with <code>shpat_</code>).
      </>
    ),
    placeholder: "Shopify Admin API access token (starts with shpat_)",
    tokenKey: "accessToken",
    extraFields: [
      { key: "shopDomain", label: "Shop domain (the permanent *.myshopify.com URL)", placeholder: "your-store.myshopify.com", type: "text", required: true },
    ],
  },
  snowflake: {
    name: "Snowflake",
    icon: <IconDatabase />,
    instructions: (
      <>
        Create a Personal Access Token in{" "}
        <a href="https://docs.snowflake.com/en/user-guide/programmatic-access-tokens" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          Snowflake → User → Personal access tokens
        </a>
        . Read-only role recommended — only SELECT/SHOW/DESC/EXPLAIN
        statements are accepted. Account identifier looks like
        <code> xy12345.us-east-1</code> (locator + region).
      </>
    ),
    placeholder: "Snowflake PAT",
    tokenKey: "pat",
    extraFields: [
      { key: "accountIdentifier", label: "Account identifier (locator.region)", placeholder: "xy12345.us-east-1", type: "text", required: true },
      { key: "user", label: "Snowflake username", placeholder: "your_user", type: "text", required: true },
      { key: "warehouse", label: "Default warehouse (optional)", placeholder: "COMPUTE_WH", type: "text", required: false },
      { key: "database", label: "Default database (optional)", placeholder: "ANALYTICS", type: "text", required: false },
      { key: "schema", label: "Default schema (optional)", placeholder: "PUBLIC", type: "text", required: false },
      { key: "role", label: "Default role (optional)", placeholder: "READ_ONLY", type: "text", required: false },
    ],
  },
};

// ------------------------------------------------------------------ providers array (kept for AddConnectionModal)

const PROVIDERS: {
  id: string;
  name: string;
  description: string;
  icon: React.ComponentType;
}[] = [
  { id: "gmail",           name: "Gmail",           description: "Read and triage your inbox.",                                                                     icon: IconEnvelope },
  { id: "github",          name: "GitHub",          description: "Read open issues and pull requests via GitHub's official MCP server.",                             icon: IconGitHub },
  { id: "gitlab",          name: "GitLab",          description: "Read projects, issues, and merge requests.",                                                       icon: IconGitlab },
  { id: "linear",          name: "Linear",          description: "Read and manage issues.",                                                                          icon: IconLinear },
  { id: "slack",           name: "Slack",           description: "Post messages and list channels.",                                                                  icon: IconSlack },
  { id: "discord",         name: "Discord",         description: "Read messages, channels, and guilds.",                                                              icon: IconDiscord },
  { id: "asana",           name: "Asana",           description: "Read workspaces, projects, and tasks.",                                                              icon: IconAsana },
  { id: "notion",          name: "Notion",          description: "Query databases, read pages, and create content.",                                                  icon: IconNotion },
  { id: "confluence",      name: "Confluence",      description: "Read and write Confluence pages and spaces.",                                                       icon: IconConfluence },
  { id: "datadog",         name: "Datadog",         description: "Query monitors, dashboards, and events.",                                                          icon: IconDatadog },
  { id: "hubspot",         name: "HubSpot",         description: "Read contacts, deals, and companies.",                                                             icon: IconHubspot },
  { id: "intercom",        name: "Intercom",        description: "Read conversations and customer data.",                                                             icon: IconIntercom },
  { id: "jira",            name: "Jira",            description: "Read and create Jira issues across projects.",                                                       icon: IconJira },
  { id: "pagerduty",       name: "PagerDuty",       description: "Read incidents, services, and on-call rotations.",                                                  icon: IconPagerduty },
  { id: "stripe",          name: "Stripe",          description: "Read payment events, customers, and subscriptions.",                                               icon: IconStripe },
  { id: "zendesk",         name: "Zendesk",         description: "Read support tickets and customer context.",                                                        icon: IconZendesk },
  { id: "google-calendar", name: "Google Calendar", description: "View your schedule.",                                                                              icon: IconCalendar },
];

// ------------------------------------------------------------------ logo URLs
// simpleicons.org CDN (v16) for most; jsDelivr npm@13 for brands removed in newer versions.
// monday.com has never been in Simple Icons — falls back to initials.

const SI_CDN = "https://cdn.simpleicons.org";
const SI_V13 = "https://cdn.jsdelivr.net/npm/simple-icons@13/icons";

// Icons served from jsDelivr are raw black SVGs — need CSS invert(1) to appear white
const NEEDS_INVERT = new Set(["slack", "salesforce", "twilio", "sendgrid"]);

function logoUrl(id: string): string | null {
  const cdnMap: Record<string, string> = {
    jira:             `${SI_CDN}/jira/ffffff`,
    notion:           `${SI_CDN}/notion/ffffff`,
    pagerduty:        `${SI_CDN}/pagerduty/ffffff`,
    drive:            `${SI_CDN}/googledrive/ffffff`,
    docs:             `${SI_CDN}/googledocs/ffffff`,
    confluence:       `${SI_CDN}/confluence/ffffff`,
    linear:           `${SI_CDN}/linear/ffffff`,
    slack:            `${SI_V13}/slack.svg`,
    discord:          `${SI_CDN}/discord/ffffff`,
    zendesk:          `${SI_CDN}/zendesk/ffffff`,
    github:           `${SI_CDN}/github/ffffff`,
    gitlab:           `${SI_CDN}/gitlab/ffffff`,
    asana:            `${SI_CDN}/asana/ffffff`,
    monday:           `https://monday.com/static/img/favicons/favicon-monday5-192.png`,
    hubspot:          `${SI_CDN}/hubspot/ffffff`,
    salesforce:       `${SI_V13}/salesforce.svg`,
    intercom:         `${SI_CDN}/intercom/ffffff`,
    gmail:            `${SI_CDN}/gmail/ffffff`,
    "google-calendar":`${SI_CDN}/googlecalendar/ffffff`,
    "google-drive":   `${SI_CDN}/googledrive/ffffff`,
    datadog:          `${SI_CDN}/datadog/ffffff`,
    stripe:           `${SI_CDN}/stripe/ffffff`,
    sentry:           `${SI_CDN}/sentry/ffffff`,
    figma:            `${SI_CDN}/figma/ffffff`,
    airtable:         `${SI_CDN}/airtable/ffffff`,
    webflow:          `${SI_CDN}/webflow/ffffff`,
    shopify:          `${SI_CDN}/shopify/ffffff`,
    twilio:           `${SI_V13}/twilio.svg`,
    sendgrid:         `${SI_V13}/sendgrid.svg`,
    snowflake:        `${SI_CDN}/snowflake/ffffff`,
    postgres:         `${SI_CDN}/postgresql/ffffff`,
    mongodb:          `${SI_CDN}/mongodb/ffffff`,
    redis:            `${SI_CDN}/redis/ffffff`,
    elasticsearch:    `${SI_CDN}/elasticsearch/ffffff`,
  };
  return cdnMap[id] ?? null;
}

// ------------------------------------------------------------------ logo tile

function LogoTile({ def, size = 56 }: { def: ConnectorDef; size?: number }) {
  const [imgFailed, setImgFailed] = useState(false);
  const radius = size >= 48 ? 12 : 8;
  const url = logoUrl(def.id);
  const iconSize = Math.round(size * 0.52);

  return (
    <div
      className="conn-logo-tile"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: def.bg,
        fontSize: Math.round(size * 0.29),
      }}
      aria-hidden="true"
    >
      {url && !imgFailed ? (
        <img
          src={url}
          width={iconSize}
          height={iconSize}
          alt=""
          onError={() => setImgFailed(true)}
          className="conn-logo-img"
          style={NEEDS_INVERT.has(def.id) ? { filter: "invert(1)" } : undefined}
        />
      ) : (
        def.initials
      )}
    </div>
  );
}

// ------------------------------------------------------------------ connector grid card

interface GridCardProps {
  def: ConnectorDef;
  statusEntry: ConnectorStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => Promise<{ ok: boolean; message?: string }>;
  loading: boolean;
  recipeCount?: number;
}

function ConnectorGridCard({ def, statusEntry, onConnect, onDisconnect, onTest, loading, recipeCount }: GridCardProps) {
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [connectSuccess, setConnectSuccess] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const testResultTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(testResultTimerRef.current);
    clearTimeout(successTimerRef.current);
  }, []);

  const isConnected = statusEntry.status === "connected";
  const isDegraded = statusEntry.status === "needs_reauth";
  const isComingSoon = !SUPPORTED_CONNECTORS.has(def.id);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
    clearTimeout(testResultTimerRef.current);
    testResultTimerRef.current = setTimeout(() => setTestResult(null), 4000);
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      await onConnect();
      setConnectSuccess(true);
      clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setConnectSuccess(false), 2500);
    } finally {
      setConnecting(false);
    }
  }

  const statusKey = isConnected ? "connected" : isDegraded ? "degraded" : isComingSoon ? "coming-soon" : "available";

  return (
    <>
      <div
        className="card cgc-card"
        data-status={statusKey}
      >
        <div className="cgc-body">
          {/* Logo tile */}
          <div className="cgc-logo-wrap" style={{ position: "relative" }}>
            <LogoTile def={def} size={48} />
            {/* Connected pulsing dot overlay */}
            {isConnected && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  bottom: 0,
                  right: 0,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--ok)",
                  border: "2px solid var(--card-bg, var(--surface))",
                  animation: "cgc-pulse 2s ease-in-out infinite",
                }}
              />
            )}
          </div>

          {/* Name + category */}
          <div className="cgc-meta">
            <div className="cgc-name">{def.name}</div>
            <div className="cgc-category">{def.category}</div>
          </div>

          {/* Status badge */}
          <div className="cgc-status-pill" data-status={statusKey}>
            {isConnected ? "Connected" : isDegraded ? "Reconnect" : isComingSoon ? "Coming Soon" : "Not Connected"}
          </div>

          {/* Scopes (when connected/degraded) — otherwise show tool count */}
          {(isConnected || isDegraded) && CONNECTOR_SCOPES[def.id] ? (
            <div className="cgc-scopes">
              {CONNECTOR_SCOPES[def.id].map((s) => (
                <span key={s} className="cgc-scope-chip">{s}</span>
              ))}
            </div>
          ) : (
            <div className="cgc-tools-count">{def.tools} available tools</div>
          )}

          {/* Recipe count badge */}
          {recipeCount !== undefined && recipeCount > 0 && (
            <div className="cgc-recipe-badge">
              <Link
                href={`/recipes?connector=${encodeURIComponent(def.id)}`}
                className="cgc-recipe-link"
                title={`${recipeCount} installed recipe${recipeCount === 1 ? "" : "s"} use this connector`}
              >
                {recipeCount} recipe{recipeCount === 1 ? "" : "s"}
              </Link>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className="cgc-test-result"
              role="status"
              aria-live="polite"
              data-ok={String(testResult.ok)}
            >
              {testResult.ok
                ? testResult.message ?? "Connection is working."
                : testResult.message ?? "Test failed — check bridge logs."}
            </div>
          )}
        </div>

        {/* Footer — only for live connectors */}
        {(isConnected || isDegraded) && (
          <div className="cgc-footer" {...(isDegraded ? { "data-degraded": "" } : {})}>
            <div className="cgc-footer-left" {...(isDegraded ? { "data-degraded": "" } : {})}>
              <span
                className="cgc-status-dot"
                {...(isDegraded ? { "data-degraded": "" } : {})}
                title={
                  statusEntry.lastSync
                    ? `Last sync: ${relativeTime(statusEntry.lastSync)}`
                    : isDegraded
                      ? "Degraded — re-auth required"
                      : "Connected"
                }
                aria-hidden="true"
                style={isConnected && !isDegraded ? { animation: "cgc-pulse 2s ease-in-out infinite" } : undefined}
              />
              {isDegraded && <span className="cgc-degraded-label">Degraded</span>}
            </div>
            <div className="cgc-footer-actions">
              {isConnected && (
                <button
                  type="button"
                  onClick={onDisconnect}
                  disabled={loading}
                  role="switch"
                  aria-checked={true}
                  aria-label={`Toggle ${def.name} off`}
                  title="Toggle off (disconnect)"
                  className="cgc-toggle"
                >
                  <span className="cgc-toggle-thumb" />
                </button>
              )}
              {isConnected && (
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || loading}
                  aria-label={`Test ${def.name} connection`}
                  className="cgc-test-btn"
                >
                  {testing ? (
                    <span className="cgc-spinner" aria-hidden="true" />
                  ) : "Test"}
                </button>
              )}
              <button
                type="button"
                onClick={isDegraded ? () => void handleConnect() : onDisconnect}
                disabled={loading}
                aria-label={isDegraded ? `Reconnect ${def.name}` : `Disconnect ${def.name}`}
                className="cgc-action-btn"
                {...(isDegraded ? { "data-degraded": "" } : {})}
              >
                {loading ? (
                  <span className="cgc-connect-btn-inner">
                    <span className="cgc-spinner" aria-hidden="true" />
                    {isDegraded ? "Reconnecting…" : "…"}
                  </span>
                ) : isDegraded ? "Reconnect" : "Disconnect"}
              </button>
            </div>
          </div>
        )}

        {/* Connect button for disconnected wave-1 */}
        {!isConnected && !isDegraded && !isComingSoon && (
          <div className="cgc-connect-footer">
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={connecting || loading}
              aria-label={`Connect ${def.name}`}
              className="cgc-connect-btn"
              style={{
                transition: "background 0.2s ease, transform 0.1s ease",
              }}
            >
              <span className="cgc-connect-btn-inner">
                {connecting ? (
                  <>
                    <span className="cgc-spinner" aria-hidden="true" />
                    Connecting…
                  </>
                ) : connectSuccess ? (
                  <>
                    <span className="cgc-checkmark" aria-hidden="true">✓</span>
                    Connected!
                  </>
                ) : "Connect"}
              </span>
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ recently used strip card

function RecentCard({ def, lastSync }: { def: ConnectorDef; lastSync: string }) {
  return (
    <div className="glass-card glass-card--hover conn-recent-card">
      <LogoTile def={def} size={40} />
      <div>
        <div className="conn-recent-name">{def.name}</div>
        <div className="conn-recent-sync">✓ {relativeTime(lastSync)}</div>
      </div>
    </div>
  );
}


// ------------------------------------------------------------------ page

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  // Connector id → number of installed recipes that reference it.
  // Derived by fetching /api/bridge/recipes once on mount and scanning
  // recipe names + descriptions for connector keywords (same heuristic
  // as the Recipes page's detectConnectors). If the bridge is offline the
  // map stays empty and no badges render — fail-soft.
  const [connectorRecipeCounts, setConnectorRecipeCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const [bridgeOffline, setBridgeOffline] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const toast = useToast();
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  // Notion modal
  const [notionModalOpen, setNotionModalOpen] = useState(false);
  const [notionToken, setNotionToken] = useState("");
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [notionErr, setNotionErr] = useState<string | null>(null);
  // Generic token modal
  const [tokenModal, setTokenModal] = useState<string | null>(null);
  const [tokenValue, setTokenValue] = useState("");
  const [tokenExtras, setTokenExtras] = useState<Record<string, string>>({});
  const [tokenConnecting, setTokenConnecting] = useState(false);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  // Add connection modal
  const [modalOpen, setModalOpen] = useState(false);
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasEverLoadedRef = useRef(false);

  async function fetchConnectors() {
    try {
      const res = await fetch(apiPath("/api/connections"));
      if (res.status >= 500) {
        // Only flip to "bridge offline" if we've never loaded data — a
        // transient 500 mid-poll (e.g., right after OAuth token storage)
        // should not wipe the connector list the user is looking at.
        if (!hasEverLoadedRef.current) {
          setBridgeOffline(true);
          setLoading(false);
        }
        return;
      }
      if (!res.ok) throw new Error(`/api/connections ${res.status}`);
      const data = (await res.json()) as { connectors: ConnectorStatus[] };
      hasEverLoadedRef.current = true;
      setConnectors(data.connectors ?? []);
      setBridgeOffline(false);
      setErr(undefined);
    } catch (e) {
      if (!hasEverLoadedRef.current) {
        setBridgeOffline(true);
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchConnectors();

    // Background poll every 30s so expired/degraded OAuth tokens show
    // an up-to-date badge instead of a stale "Connected" forever.
    const pollId = setInterval(() => {
      void fetchConnectors();
    }, 30_000);

    // Fetch installed recipes and derive connector→recipe count map.
    // Tool-prefix heuristic mirrors the Recipes page detectConnectors fn.
    const TOOL_KEYWORD_TO_CONNECTOR_ID: Record<string, string> = {
      slack: "slack",
      github: "github",
      jira: "jira",
      linear: "linear",
      gmail: "gmail",
      calendar: "google-calendar",
      googlecalendar: "google-calendar",
      intercom: "intercom",
      hubspot: "hubspot",
      datadog: "datadog",
      stripe: "stripe",
      sentry: "sentry",
      notion: "notion",
      discord: "discord",
      confluence: "confluence",
      pagerduty: "pagerduty",
      zendesk: "zendesk",
      asana: "asana",
      gitlab: "gitlab",
    };
    fetch(apiPath("/api/bridge/recipes"))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { recipes?: Array<{ name: string; description?: string }>; } | Array<{ name: string; description?: string }> | null) => {
        const list: Array<{ name: string; description?: string }> = Array.isArray(data)
          ? data
          : Array.isArray((data as { recipes?: unknown })?.recipes)
            ? ((data as { recipes: Array<{ name: string; description?: string }> }).recipes)
            : [];
        const counts = new Map<string, number>();
        for (const recipe of list) {
          const haystack = `${recipe.name} ${recipe.description ?? ""}`.toLowerCase();
          const seen = new Set<string>();
          for (const [keyword, connId] of Object.entries(TOOL_KEYWORD_TO_CONNECTOR_ID)) {
            if (!seen.has(connId) && haystack.includes(keyword)) {
              counts.set(connId, (counts.get(connId) ?? 0) + 1);
              seen.add(connId);
            }
          }
        }
        setConnectorRecipeCounts(counts);
      })
      .catch(() => {});

    return () => {
      clearInterval(pollId);
    };
  }, []);

  function getConnector(id: string): ConnectorStatus {
    return connectors.find((c) => c.id === id) ?? { id, status: "disconnected" };
  }

  async function handleNotionConnect() {
    // Audit 2026-05-17 (#600): Notion issues both legacy `secret_` and
    // newer `ntn_` token prefixes. Rejecting `ntn_` was a false-negative
    // that locked out valid users with current API keys.
    if (!notionToken.startsWith("secret_") && !notionToken.startsWith("ntn_")) {
      setNotionErr('Token must start with "secret_" or "ntn_" — find it in Notion → Settings → Connections → Your integrations');
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
    // Audit 2026-05-17 (#600): validate BEFORE flipping the spinner.
    // The previous order set tokenConnecting=true then early-returned
    // on missing fields without resetting it — the Save button got
    // stuck on "Connecting…" forever until the modal was reopened.
    const cfg = TOKEN_MODAL_CONNECTORS[tokenModal];
    const missing = (cfg.extraFields ?? [])
      .filter((f) => f.required && !tokenExtras[f.key]?.trim())
      .map((f) => f.label);
    if (missing.length > 0) {
      setTokenErr(`Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
      return;
    }
    setTokenConnecting(true);
    setTokenErr(null);
    const payload: Record<string, string> = { [cfg.tokenKey]: tokenValue };
    for (const f of cfg.extraFields ?? []) {
      const v = tokenExtras[f.key]?.trim();
      if (v) payload[f.key] = v;
    }
    try {
      const res = await fetch(apiPath(`/api/connections/${tokenModal}/connect`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setTokenErr(body.error ?? `Error ${res.status}`);
        return;
      }
      setTokenValue("");
      setTokenExtras({});
      setTokenModal(null);
      await fetchConnectors();
    } catch (e) {
      setTokenErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTokenConnecting(false);
    }
  }

  function handleConnect(id: string): Promise<"connected" | "timeout" | "blocked"> {
    if (id === "notion") {
      setNotionModalOpen(true);
      setNotionErr(null);
      return Promise.resolve("connected");
    }
    if (id in TOKEN_MODAL_CONNECTORS) {
      setTokenModal(id);
      setTokenValue("");
      setTokenExtras({});
      setTokenErr(null);
      return Promise.resolve("connected");
    }
    const popup = window.open(apiPath(`/api/connections/${id}/auth`), "_blank");
    if (!popup) {
      // Audit 2026-05-17 (#600): blocked-popup state was silently
      // returned to runReAuthAll but ignored by per-card Connect clicks,
      // so single-card connects looked like the button did nothing.
      // Surface here so every caller benefits.
      toast.error(
        `Browser blocked the ${id} popup. Allow popups for this site and try again.`,
      );
      return Promise.resolve("blocked");
    }
    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        if (popup.closed) {
          clearInterval(poll);
          clearTimeout(timeoutId);
          await fetchConnectors();
          resolve("connected");
          return;
        }
        const res = await fetch(apiPath("/api/connections")).catch(() => null);
        if (!res) return;
        const data = (await res.json().catch(() => null)) as { connectors: ConnectorStatus[] } | null;
        if (!data) return;
        const updated = data.connectors.find((c) => c.id === id);
        if (updated?.status === "connected") {
          setConnectors(data.connectors);
          clearInterval(poll);
          clearTimeout(timeoutId);
          try { popup.close(); } catch {}
          resolve("connected");
        }
      }, 3000);
      oauthPollRef.current = poll;
      const timeoutId = setTimeout(() => {
        clearInterval(poll);
        if (oauthPollRef.current === poll) oauthPollRef.current = null;
        resolve("timeout");
      }, 120_000);
    });
  }

  const [reAuthing, setReAuthing] = useState(false);
  const [reAuthMsg, setReAuthMsg] = useState<string | null>(null);
  const [reAuthConfirmOpen, setReAuthConfirmOpen] = useState(false);

  // Targets resolved at click-time so the confirm dialog enumerates the
  // exact connectors that will be re-authed.
  const reAuthTargets = useMemo(
    () =>
      connectors.filter(
        (c) => c.status === "connected" || c.status === "needs_reauth",
      ),
    [connectors],
  );

  async function runReAuthAll() {
    setReAuthConfirmOpen(false);
    if (reAuthing) return;
    const targets = reAuthTargets.map((c) => c.id);
    if (targets.length === 0) return;
    setReAuthing(true);
    setReAuthMsg(null);
    try {
      let blocked = 0;
      for (const id of targets) {
        const result = await handleConnect(id);
        if (result === "blocked") {
          blocked++;
          break;
        }
      }
      if (blocked > 0) {
        setReAuthMsg(
          "Browser blocked the popup. Allow popups for this site, then click Re-auth all again.",
        );
      }
    } finally {
      setReAuthing(false);
    }
  }

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (typeof e.data !== "string") return;
      const ok = /^patchwork:([a-z-]+):connected$/.exec(e.data);
      if (ok) {
        fetchConnectors();
        return;
      }
      const errMatch = /^patchwork:([a-z-]+):error(?::(.*))?$/.exec(e.data);
      if (errMatch) {
        const [, connectorId, reason] = errMatch;
        const decoded = reason ? decodeURIComponent(reason) : "Authorization failed";
        toast.error(`${connectorId}: ${decoded}`);
        return;
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (oauthPollRef.current !== null) {
        clearInterval(oauthPollRef.current);
        oauthPollRef.current = null;
      }
    };
  }, []);

  async function handleDisconnect(id: string) {
    setActing(id);
    try {
      const res = await fetch(apiPath(`/api/connections/${id}`), { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? `Error ${res.status}`);
        return;
      }
      setConnectors((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "disconnected", lastSync: undefined } : c)),
      );
      toast.success(`Disconnected ${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  async function handleTest(id: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await fetch(apiPath(`/api/connections/${id}/test`), { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) return { ok: false, message: body.error ?? `Error ${res.status}` };
      return { ok: body.ok !== false, message: body.message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- derived state
  const [statusFilter, setStatusFilter] = useState<"all" | "connected" | "available" | "coming_soon">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const hasAnyConnected = connectors.some((c) => c.status === "connected" || c.status === "needs_reauth");

  const recentlyUsed = CATALOG
    .map((def) => ({ def, entry: getConnector(def.id) }))
    .filter(({ entry }) => entry.status === "connected" && entry.lastSync)
    .sort((a, b) => Date.parse(b.entry.lastSync!) - Date.parse(a.entry.lastSync!))
    .slice(0, 4);

  function defStatus(def: ConnectorDef): "connected" | "available" | "coming_soon" {
    const entry = getConnector(def.id);
    if (entry.status === "connected" || entry.status === "needs_reauth") return "connected";
    if (!SUPPORTED_CONNECTORS.has(def.id)) return "coming_soon";
    return "available";
  }

  const counts = {
    all: CATALOG.length,
    connected: CATALOG.filter((d) => defStatus(d) === "connected").length,
    available: CATALOG.filter((d) => defStatus(d) === "available").length,
    coming_soon: CATALOG.filter((d) => defStatus(d) === "coming_soon").length,
  };

  const q = searchQuery.trim().toLowerCase();
  const visibleCatalog = CATALOG.filter((d) => {
    if (statusFilter !== "all" && defStatus(d) !== statusFilter) return false;
    if (q && !d.name.toLowerCase().includes(q) && !d.id.toLowerCase().includes(q)) return false;
    return true;
  });

  // ---- render

  return (
    <section>
      <div className="page-head">
        <div>
          <div className="page-head-title-row">
            <h1 className="editorial-h1">
              Connections — <span className="accent">writes are gated. Reads are not.</span>
            </h1>
            <HintCard.Toggle id="connections" />
          </div>
          <div className="editorial-sub">
            oauth · scoped to your machine · tokens in ~/.patchwork/secrets
          </div>
          <RelationStrip
            items={[
              { label: "Recipes", href: "/recipes", title: "Recipes that use these connectors" },
              { label: "Inbox", href: "/inbox", title: "Outputs produced via these connectors" },
              { label: "Marketplace", href: "/marketplace", title: "Find recipes for these providers" },
            ]}
          />
        </div>
        {!loading && !bridgeOffline && (
          <div className="conn-toolbar">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search connectors…"
              className="input conn-search"
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => setReAuthConfirmOpen(true)}
              disabled={reAuthing || reAuthTargets.length === 0}
              title="Re-authorize all connected providers (one at a time)"
              aria-busy={reAuthing}
            >
              {reAuthing ? "Re-authing…" : "↻ Re-auth all"}
            </button>
            {reAuthMsg && (
              <span role="status" className="conn-reauth-msg">{reAuthMsg}</span>
            )}
          </div>
        )}
      </div>

      <HintCard id="connections" />

      {/*
        Plumbing-audit fix: the connector-request form used to be
        write-only — submitted requests vanished into
        ~/.patchwork/connector-requests.json. This panel reads from
        the new GET handler so users can see what they've asked for.
      */}
      <YourConnectorRequests />

      {err && <div className="alert-err" role="alert">{err}</div>}

      {bridgeOffline ? (
        <EmptyState
          title="Bridge offline"
          description={
            <>
              The bridge is not running. Start it with{" "}
              <code>patchwork start-all</code> then reload this page.
            </>
          }
        />
      ) : loading ? (
        <SkeletonList rows={3} columns={2} />
      ) : (
        <>
          {/* Recently used strip */}
          {recentlyUsed.length > 0 && (
            <div className="conn-recent-section">
              <div className="conn-recent-label">Recently used</div>
              <div className="conn-recent-scroll">
                {recentlyUsed.map(({ def, entry }) => (
                  <RecentCard key={def.id} def={def} lastSync={entry.lastSync!} />
                ))}
              </div>
            </div>
          )}

          {/* Empty state CTA */}
          {!hasAnyConnected && (
            <div
              className="conn-empty-cta"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 16,
                padding: "40px 24px",
                marginBottom: "var(--s-4)",
                background: "var(--card-bg)",
                border: "2px dashed var(--line-2)",
                borderRadius: "var(--radius)",
                textAlign: "center",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "rgba(var(--accent-rgb, 99, 102, 241), 0.1)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                }}
              >
                🔌
              </div>
              <div>
                <p
                  className="conn-empty-cta-text"
                  style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--ink-0)" }}
                >
                  No connections yet
                </p>
                <p style={{ margin: 0, fontSize: "var(--fs-s)", color: "var(--ink-2)" }}>
                  Connect a service to start automating workflows.
                </p>
              </div>
              <button
                type="button"
                className="btn primary"
                onClick={() => setModalOpen(true)}
                style={{ minWidth: 140 }}
              >
                + Add connection
              </button>
            </div>
          )}

          {/* Status filter pills */}
          <div className="conn-filter-pills">
            {([
              ["all", `All [${counts.all}]`],
              ["connected", `Connected [${counts.connected}]`],
              ["available", `Available [${counts.available}]`],
              ["coming_soon", `Coming soon [${counts.coming_soon}]`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setStatusFilter(k)}
                className={statusFilter === k ? "pill accent conn-filter-pill" : "pill muted conn-filter-pill"}
              >
                {label}
              </button>
            ))}
          </div>

          {(() => {
            const connected = visibleCatalog.filter((d) => {
              const s = getConnector(d.id).status;
              return s === "connected" || s === "needs_reauth";
            });
            const notConnected = visibleCatalog.filter((d) => {
              const s = getConnector(d.id).status;
              return s !== "connected" && s !== "needs_reauth";
            });
            return (
              <>
                {connected.length > 0 && statusFilter === "all" && (
                  <div style={{ marginBottom: "var(--s-2)" }}>
                    <div
                      style={{
                        fontSize: "var(--fs-xs)",
                        fontWeight: 600,
                        color: "var(--ok)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        marginBottom: "var(--s-3)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--ok)",
                          display: "inline-block",
                        }}
                      />
                      Connected ({connected.length})
                    </div>
                    <div className="conn-grid">
                      {connected.map((def) => (
                        <ConnectorGridCard
                          key={def.id}
                          def={def}
                          statusEntry={getConnector(def.id)}
                          onConnect={() => handleConnect(def.id)}
                          onDisconnect={() => setConfirmDisconnectId(def.id)}
                          onTest={() => handleTest(def.id)}
                          loading={acting === def.id}
                          recipeCount={connectorRecipeCounts.get(def.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {notConnected.length > 0 && statusFilter === "all" && connected.length > 0 && (
                  <div
                    style={{
                      fontSize: "var(--fs-xs)",
                      fontWeight: 600,
                      color: "var(--ink-3)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      marginBottom: "var(--s-3)",
                      marginTop: "var(--s-2)",
                    }}
                  >
                    Available ({notConnected.length})
                  </div>
                )}
                <div className="conn-grid">
                  {(statusFilter === "all" ? notConnected : visibleCatalog).map((def) => (
                    <ConnectorGridCard
                      key={def.id}
                      def={def}
                      statusEntry={getConnector(def.id)}
                      onConnect={() => handleConnect(def.id)}
                      onDisconnect={() => setConfirmDisconnectId(def.id)}
                      onTest={() => handleTest(def.id)}
                      loading={acting === def.id}
                      recipeCount={connectorRecipeCounts.get(def.id)}
                    />
                  ))}
                </div>
              </>
            );
          })()}
        </>
      )}

      {/* Re-auth-all confirmation */}
      <Dialog
        open={reAuthConfirmOpen}
        onClose={() => setReAuthConfirmOpen(false)}
        ariaLabelledBy="reauth-confirm-title"
        maxWidth={420}
      >
        <div className="conn-modal-body">
          <strong id="reauth-confirm-title" className="conn-modal-title">
            Re-authorize {reAuthTargets.length} connector
            {reAuthTargets.length === 1 ? "" : "s"}?
          </strong>
          <p className="conn-modal-desc">
            One OAuth popup will open at a time, in order. Each waits for you to
            finish before the next one opens — you can cancel between popups by
            closing the window.
          </p>
          {reAuthTargets.length > 0 && (
            <ul className="conn-reauth-list">
              {reAuthTargets.map((c) => (
                <li key={c.id}>{c.id}</li>
              ))}
            </ul>
          )}
          <div className="conn-modal-actions">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => setReAuthConfirmOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => void runReAuthAll()}
              disabled={reAuthTargets.length === 0}
            >
              Start re-auth
            </button>
          </div>
        </div>
      </Dialog>

      {/* Notion token-paste modal */}
      <Dialog
        open={notionModalOpen}
        onClose={() => { setNotionModalOpen(false); setNotionToken(""); setNotionErr(null); }}
        ariaLabelledBy="notion-modal-title"
        maxWidth={420}
      >
        <div className="conn-modal-body">
          <div className="conn-modal-header">
            <IconNotion />
            <strong id="notion-modal-title" className="conn-modal-title">Connect Notion</strong>
          </div>
          <p className="conn-modal-desc">
            Create an internal integration at{" "}
            <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer" className="conn-modal-link">
              notion.so/my-integrations
            </a>
            , copy the integration token, and paste it below. Then share your databases/pages with the integration inside Notion.
          </p>
          <input
            type="password"
            placeholder="secret_..."
            value={notionToken}
            onChange={(e) => setNotionToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleNotionConnect(); }}
            className="conn-modal-input"
          />
          {notionErr && <div className="alert-err conn-modal-err" role="alert">{notionErr}</div>}
          <div className="conn-modal-actions">
            <button
              type="button"
              className="conn-modal-cancel"
              onClick={() => { setNotionModalOpen(false); setNotionToken(""); setNotionErr(null); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="conn-modal-submit"
              onClick={() => void handleNotionConnect()}
              disabled={notionConnecting || !notionToken}
            >
              {notionConnecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </Dialog>

      {/* Generic token-paste modal */}
      <Dialog
        open={Boolean(tokenModal && TOKEN_MODAL_CONNECTORS[tokenModal])}
        onClose={() => { setTokenModal(null); setTokenValue(""); setTokenExtras({}); setTokenErr(null); }}
        ariaLabelledBy="token-modal-title"
        maxWidth={440}
      >
        {tokenModal && TOKEN_MODAL_CONNECTORS[tokenModal] && (
          <div className="conn-modal-body">
            <div className="conn-modal-header">
              {TOKEN_MODAL_CONNECTORS[tokenModal].icon}
              <strong id="token-modal-title" className="conn-modal-title">Connect {TOKEN_MODAL_CONNECTORS[tokenModal].name}</strong>
            </div>
            <p className="conn-modal-desc">
              {TOKEN_MODAL_CONNECTORS[tokenModal].instructions}
            </p>
            <input
              type="password"
              placeholder={TOKEN_MODAL_CONNECTORS[tokenModal].placeholder}
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleTokenConnect(); }}
              aria-label={`${TOKEN_MODAL_CONNECTORS[tokenModal].name} ${TOKEN_MODAL_CONNECTORS[tokenModal].placeholder}`}
              className="conn-modal-input"
            />
            {(TOKEN_MODAL_CONNECTORS[tokenModal].extraFields ?? []).map((f) => (
              <div key={f.key} className="conn-modal-field">
                <label htmlFor={`token-extra-${f.key}`} className="conn-modal-field-label">
                  {f.label}{f.required ? " *" : ""}
                </label>
                <input
                  id={`token-extra-${f.key}`}
                  type={f.type ?? "text"}
                  placeholder={f.placeholder}
                  value={tokenExtras[f.key] ?? ""}
                  onChange={(e) => setTokenExtras((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleTokenConnect(); }}
                  className="conn-modal-input"
                />
              </div>
            ))}
            {tokenErr && <div className="alert-err conn-modal-err" role="alert">{tokenErr}</div>}
            <div className="conn-modal-actions">
              <button
                type="button"
                className="conn-modal-cancel"
                onClick={() => { setTokenModal(null); setTokenValue(""); setTokenExtras({}); setTokenErr(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="conn-modal-submit"
                onClick={() => void handleTokenConnect()}
                disabled={tokenConnecting || !tokenValue.trim()}
              >
                {tokenConnecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        )}
      </Dialog>

      <AddConnectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        connectors={connectors}
        acting={acting}
        onConnect={handleConnect}
        providers={PROVIDERS}
      />

      <Dialog
        open={confirmDisconnectId !== null}
        onClose={() => setConfirmDisconnectId(null)}
        ariaLabelledBy="disconnect-confirm-title"
        maxWidth={420}
      >
        {(() => {
          const id = confirmDisconnectId;
          const def = id ? CATALOG.find((d) => d.id === id) : undefined;
          const displayName = def?.name ?? id ?? "this connector";
          const busy = id ? acting === id : false;
          return (
            <div className="conn-modal-body conn-modal-body--sm">
              <strong id="disconnect-confirm-title" className="conn-modal-title">
                Disconnect {displayName}?
              </strong>
              <p className="conn-modal-desc">
                Recipes that use {displayName} will fail until you reconnect.
                Patchwork will keep your existing recipe definitions; only the auth token is removed.
              </p>
              <div className="conn-modal-actions conn-modal-actions--mt">
                <button
                  type="button"
                  className="conn-modal-cancel-sm"
                  onClick={() => setConfirmDisconnectId(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="conn-modal-danger"
                  onClick={async () => {
                    if (!id) return;
                    await handleDisconnect(id);
                    setConfirmDisconnectId(null);
                  }}
                  disabled={busy}
                >
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </div>
          );
        })()}
      </Dialog>
    </section>
  );
}
