"use client";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api";
import AddConnectionModal from "./AddConnectionModal";

interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
}

// ------------------------------------------------------------------ helpers

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
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
  { id: "docs",             name: "Docs",             initials: "DO", category: "Docs",       wave: 1, tools: 3,  bg: "#4285F4" },
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


// ------------------------------------------------------------------ icon SVG components (kept for modals)

function IconEnvelope() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 7l8 5 8-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 2v4M14 2v4M2 9h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconGitHub() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fillRule="evenodd" clipRule="evenodd" d="M10 2a8 8 0 00-2.529 15.591c.4.074.546-.174.546-.386 0-.19-.007-.693-.01-1.36-2.226.483-2.695-1.073-2.695-1.073-.364-.924-.888-1.17-.888-1.17-.726-.496.055-.486.055-.486.803.056 1.226.824 1.226.824.713 1.221 1.872.869 2.328.664.072-.517.279-.869.508-1.069-1.776-.202-3.644-.888-3.644-3.953 0-.873.312-1.587.824-2.147-.083-.202-.357-1.016.078-2.117 0 0 .672-.215 2.2.82a7.67 7.67 0 012-.27c.679.003 1.363.092 2 .27 1.527-1.035 2.198-.82 2.198-.82.436 1.101.162 1.915.08 2.117.513.56.822 1.274.822 2.147 0 3.073-1.871 3.749-3.653 3.947.287.248.543.735.543 1.48 0 1.069-.01 1.932-.01 2.194 0 .214.144.463.55.385A8.001 8.001 0 0010 2z" fill="currentColor" />
    </svg>
  );
}

function IconGitlab() {
  // Stylized geometric mark — three triangles converging on a center line.
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M10 17l-7-9 2-5 2 5h6l2-5 2 5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 17L7 8M10 17l3-9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconLinear() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M3.5 13.207L6.793 16.5l9.207-9.207-3.293-3.293L3.5 13.207z" fill="currentColor" opacity="0.5" />
      <path d="M3.293 12.293l4.414 4.414L16.414 8l-4.414-4.414L3.293 12.293z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function IconSlack() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M7 3v14M13 3v14M3 7h14M3 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconNotion() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 6l6 8M7 6h3M13 14h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAsana() {
  // Asana brand mark — three dots arranged in a triangle (top, bottom-left, bottom-right).
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="10" cy="6" r="2.5" fill="currentColor" />
      <circle cx="5.5" cy="13" r="2.5" fill="currentColor" />
      <circle cx="14.5" cy="13" r="2.5" fill="currentColor" />
    </svg>
  );
}

function IconConfluence() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M3 14c2-3 4-5 7-5s5 2 7-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 10c2-3 4-5 7-5s5 2 7-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconDiscord() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" />
      <circle cx="12.5" cy="10" r="1" fill="currentColor" />
      <path d="M5 16l1.5 2M15 16l-1.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconJira() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M10 3l7 7-7 7-7-7 7-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 7l3 3-3 3-3-3 3-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconDatadog() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="5" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 5V3M14 5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconHubspot() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconPagerduty() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M10 2a4 4 0 00-4 4v3a3 3 0 01-1.5 2.6L3 13h14l-1.5-1.4A3 3 0 0114 9V6a4 4 0 00-4-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 16a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconIntercom() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="3" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 17l2-3h4l2 3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 8h8M6 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconStripe() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 8h16" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="11" width="4" height="2" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function IconZendesk() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M4 10a6 6 0 0112 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="2" y="10" width="3" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="15" y="10" width="3" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17 15v1a3 3 0 01-3 3h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
]);

const TOKEN_MODAL_CONNECTORS: Record<string, TokenModalConfig> = {
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
  jira: {
    name: "Jira",
    icon: <IconJira />,
    instructions: (
      <>
        Generate an API token at{" "}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          id.atlassian.com/manage-profile/security/api-tokens
        </a>
        . Paste it below along with your Atlassian base URL (e.g. <code>https://your-org.atlassian.net</code>) and your Atlassian account email — the bridge stores all three.
      </>
    ),
    placeholder: "Atlassian API token",
    tokenKey: "token",
  },
  pagerduty: {
    name: "PagerDuty",
    icon: <IconPagerduty />,
    instructions: (
      <>
        Generate a personal or general API access key in{" "}
        <a href="https://support.pagerduty.com/docs/api-access-keys" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          PagerDuty → Integrations → API Access Keys
        </a>
        . Read-only keys are sufficient for this PR's incident, service, and on-call queries.
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
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: def.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#fff",
        fontWeight: 700,
        fontSize: Math.round(size * 0.29),
        letterSpacing: "0.02em",
        fontFamily: "var(--font-mono)",
        overflow: "hidden",
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
          style={{ display: "block", objectFit: "contain", filter: NEEDS_INVERT.has(def.id) ? "invert(1)" : undefined }}
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
}

function ConnectorGridCard({ def, statusEntry, onConnect, onDisconnect, onTest, loading }: GridCardProps) {
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [testing, setTesting] = useState(false);

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
    setTimeout(() => setTestResult(null), 4000);
  }

  const borderColor = isDegraded
    ? "var(--warn)"
    : isConnected
    ? "rgba(34,197,94,0.35)"
    : "var(--border-default)";

  return (
    <div
      className="card beam"
      style={{
        background: isDegraded ? "rgba(234,179,8,0.03)" : undefined,
        borderColor: borderColor,
        display: "flex",
        flexDirection: "column",
        gap: 0,
        overflow: "hidden",
        padding: 0,
      }}
    >
      <div style={{ padding: "16px 16px 14px" }}>
        {/* Logo tile */}
        <div style={{ marginBottom: 12 }}>
          <LogoTile def={def} size={48} />
        </div>

        {/* Name + category */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink-0)", lineHeight: 1.25, marginBottom: 2 }}>
            {def.name}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 400 }}>{def.category}</div>
        </div>

        {/* Status badge */}
        {isConnected ? (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 9px", borderRadius: 999,
            background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.22)",
            fontSize: 10, fontWeight: 700, color: "#15803d",
            textTransform: "uppercase", letterSpacing: "0.07em",
            marginBottom: 10,
          }}>
            Connected
          </div>
        ) : isDegraded ? (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 9px", borderRadius: 999,
            background: "rgba(234,179,8,0.10)", border: "1px solid rgba(234,179,8,0.28)",
            fontSize: 10, fontWeight: 700, color: "#92400e",
            textTransform: "uppercase", letterSpacing: "0.07em",
            marginBottom: 10,
          }}>
            Reconnect
          </div>
        ) : (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 9px", borderRadius: 999,
            background: isComingSoon ? "rgba(99,91,255,0.07)" : "rgba(148,163,184,0.08)",
            border: `1px solid ${isComingSoon ? "rgba(99,91,255,0.18)" : "rgba(148,163,184,0.18)"}`,
            fontSize: 10, fontWeight: 700, color: isComingSoon ? "#5048c8" : "var(--ink-3)",
            textTransform: "uppercase", letterSpacing: "0.07em",
            marginBottom: 10,
          }}>
            {isComingSoon ? "Coming Soon" : "Not Connected"}
          </div>
        )}

        {/* Tool count */}
        <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 400 }}>
          {def.tools} available tools
        </div>

        {/* Test result */}
        {testResult && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginTop: 8,
              padding: "6px 10px",
              borderRadius: "var(--r-2)",
              fontSize: 11,
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

      {/* Footer — only for live connectors */}
      {(isConnected || isDegraded) && (
        <div
          style={{
            borderTop: `1px solid ${isDegraded ? "rgba(234,179,8,0.18)" : "var(--border-default)"}`,
            padding: "9px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: isDegraded ? "rgba(234,179,8,0.03)" : "rgba(0,0,0,0.012)",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: isDegraded ? "#92400e" : "var(--ink-2)", minWidth: 0, overflow: "hidden" }}>
            <span
              style={{
                width: 6, height: 6, borderRadius: "50%",
                background: isDegraded ? "#f59e0b" : "var(--ok)",
                flexShrink: 0,
              }}
              aria-hidden="true"
            />
            <span style={{ fontWeight: 500, flexShrink: 0 }}>{isDegraded ? "Degraded" : "Connected"}</span>
            {statusEntry.lastSync && (
              <span style={{ color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                · {relativeTime(statusEntry.lastSync)}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {isConnected && (
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || loading}
                aria-label={`Test ${def.name} connection`}
                style={{
                  fontSize: 11, fontWeight: 500, padding: "3px 9px",
                  borderRadius: 5, border: "1px solid var(--border-default)",
                  background: "var(--card-bg)", color: "var(--ink-1)",
                  cursor: testing ? "wait" : "pointer",
                  opacity: (testing || loading) ? 0.55 : 1,
                }}
              >
                {testing ? "…" : "Test"}
              </button>
            )}
            <button
              type="button"
              onClick={isDegraded ? onConnect : onDisconnect}
              disabled={loading}
              aria-label={isDegraded ? `Reconnect ${def.name}` : `Disconnect ${def.name}`}
              style={{
                fontSize: 11, fontWeight: 500, padding: "3px 9px",
                borderRadius: 5, border: "none",
                background: isDegraded ? "rgba(234,179,8,0.14)" : "rgba(239,68,68,0.09)",
                color: isDegraded ? "#92400e" : "#dc2626",
                cursor: loading ? "wait" : "pointer",
                opacity: loading ? 0.55 : 1,
              }}
            >
              {loading ? "…" : isDegraded ? "Reconnect" : "Disconnect"}
            </button>
          </div>
        </div>
      )}

      {/* Connect button for disconnected wave-1 */}
      {!isConnected && !isDegraded && !isComingSoon && (
        <div style={{ borderTop: "1px solid var(--border-default)", padding: "10px 14px" }}>
          <button
            type="button"
            onClick={onConnect}
            disabled={loading}
            aria-label={`Connect ${def.name}`}
            style={{
              width: "100%", fontSize: 12, fontWeight: 600, padding: "7px 0",
              borderRadius: 6, border: "none",
              background: "var(--accent)", color: "#fff",
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.55 : 1,
              letterSpacing: "0.01em",
            }}
          >
            {loading ? "Connecting…" : "Connect"}
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ recently used strip card

function RecentCard({ def, lastSync }: { def: ConnectorDef; lastSync: string }) {
  return (
    <div
      className="glass-card glass-card--hover"
      style={{
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 160,
        maxWidth: 200,
        flexShrink: 0,
      }}
    >
      <LogoTile def={def} size={40} />
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink-0)" }}>{def.name}</div>
        <div style={{ fontSize: 11, color: "#16a34a", marginTop: 2, fontWeight: 500 }}>
          ✓ {relativeTime(lastSync)}
        </div>
      </div>
    </div>
  );
}


// ------------------------------------------------------------------ page

export default function ConnectionsPage() {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const [bridgeOffline, setBridgeOffline] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Notion modal
  const [notionModalOpen, setNotionModalOpen] = useState(false);
  const [notionToken, setNotionToken] = useState("");
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [notionErr, setNotionErr] = useState<string | null>(null);
  // Generic token modal
  const [tokenModal, setTokenModal] = useState<string | null>(null);
  const [tokenValue, setTokenValue] = useState("");
  const [tokenConnecting, setTokenConnecting] = useState(false);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  // Add connection modal
  const [modalOpen, setModalOpen] = useState(false);
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    window.open(apiPath(`/api/connections/${id}/auth`), "_blank");
    oauthPollRef.current = setInterval(async () => {
      const res = await fetch(apiPath("/api/connections")).catch(() => null);
      if (!res) return;
      const data = (await res.json().catch(() => null)) as { connectors: ConnectorStatus[] } | null;
      if (!data) return;
      const updated = data.connectors.find((c) => c.id === id);
      if (updated?.status === "connected") {
        setConnectors(data.connectors);
        clearInterval(oauthPollRef.current!);
        oauthPollRef.current = null;
      }
    }, 3000);
    setTimeout(() => {
      if (oauthPollRef.current !== null) {
        clearInterval(oauthPollRef.current);
        oauthPollRef.current = null;
      }
    }, 120_000);
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
    setActionErr(null);
    try {
      const res = await fetch(apiPath(`/api/connections/${id}`), { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
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
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) return { ok: false, message: body.error ?? `Error ${res.status}` };
      return { ok: body.ok !== false, message: body.message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- derived state
  const [waveFilter, setWaveFilter] = useState<0 | 1 | 2 | 3>(0); // 0 = all

  const hasAnyConnected = connectors.some((c) => c.status === "connected" || c.status === "needs_reauth");

  const recentlyUsed = CATALOG
    .map((def) => ({ def, entry: getConnector(def.id) }))
    .filter(({ entry }) => entry.status === "connected" && entry.lastSync)
    .sort((a, b) => Date.parse(b.entry.lastSync!) - Date.parse(a.entry.lastSync!))
    .slice(0, 4);

  const WAVE_LABELS: Record<1 | 2 | 3, string> = { 1: "MVP", 2: "Core", 3: "Expand" };

  function waveProgress(wave: 1 | 2 | 3) {
    const defs = CATALOG.filter((d) => d.wave === wave);
    const connected = defs.filter((d) => getConnector(d.id).status === "connected").length;
    return { total: defs.length, connected };
  }

  const visibleCatalog = waveFilter === 0 ? CATALOG : CATALOG.filter((d) => d.wave === waveFilter);

  // ---- render

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <div className="page-head-sub">Link your accounts so Patchwork can act on your behalf.</div>
        </div>
        {!loading && !bridgeOffline && hasAnyConnected && (
          <button type="button" className="btn sm primary" onClick={() => setModalOpen(true)}>
            Add connection
          </button>
        )}
      </div>

      {err && <div className="alert-err" role="alert">{err}</div>}
      {actionErr && <div className="alert-err" role="alert">{actionErr}</div>}

      {bridgeOffline ? (
        <div className="empty-state" role="status">
          <h3>Bridge offline</h3>
          <p>The bridge is not running. Start it with <code>patchwork start-all</code> then reload this page.</p>
        </div>
      ) : loading ? (
        <div className="empty-state" role="status" aria-busy="true">
          <p>Loading…</p>
        </div>
      ) : (
        <>
          {/* Recently used strip */}
          {recentlyUsed.length > 0 && (
            <div style={{ marginBottom: "var(--s-5)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Recently used
              </div>
              <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
                {recentlyUsed.map(({ def, entry }) => (
                  <RecentCard key={def.id} def={def} lastSync={entry.lastSync!} />
                ))}
              </div>
            </div>
          )}

          {/* Empty state CTA */}
          {!hasAnyConnected && (
            <div style={{ textAlign: "center", padding: "var(--s-6) 0", marginBottom: "var(--s-5)" }}>
              <p style={{ color: "var(--ink-2)", fontSize: 14, marginBottom: "var(--s-4)" }}>
                No connections yet. Add one to get started.
              </p>
              <button type="button" className="btn primary" onClick={() => setModalOpen(true)}>
                Add connection
              </button>
            </div>
          )}

          {/* Wave filter tabs */}
          <div style={{ display: "flex", gap: 8, marginBottom: "var(--s-4)", flexWrap: "wrap" }}>
            {([0, 1, 2, 3] as const).map((w) => {
              const label = w === 0 ? "All" : `Wave ${w} — ${WAVE_LABELS[w]}`;
              const prog = w !== 0 ? waveProgress(w) : null;
              return (
                <button
                  key={w}
                  type="button"
                  className={`btn sm${waveFilter === w ? " primary" : " ghost"}`}
                  onClick={() => setWaveFilter(w)}
                  style={{ gap: 6 }}
                >
                  {label}
                  {prog && (
                    <span style={{ fontSize: 10, opacity: 0.75 }}>
                      {prog.connected}/{prog.total}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Connectors — grouped by wave when showing all, flat when filtered */}
          {waveFilter === 0 ? (
            ([1, 2, 3] as const).map((wave) => {
              const defs = CATALOG.filter((d) => d.wave === wave);
              const prog = waveProgress(wave);
              return (
                <div key={wave} style={{ marginBottom: "var(--s-6)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                      Wave {wave} — {WAVE_LABELS[wave]}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {prog.connected}/{prog.total} connected
                    </span>
                    <div style={{ flex: 1, height: 2, background: "var(--border)", borderRadius: 1 }}>
                      <div style={{ height: 2, borderRadius: 1, background: "var(--ok)", width: `${prog.total ? (prog.connected / prog.total) * 100 : 0}%`, transition: "width 0.3s ease" }} />
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                    {defs.map((def) => (
                      <ConnectorGridCard
                        key={def.id}
                        def={def}
                        statusEntry={getConnector(def.id)}
                        onConnect={() => handleConnect(def.id)}
                        onDisconnect={() => handleDisconnect(def.id)}
                        onTest={() => handleTest(def.id)}
                        loading={acting === def.id}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12, marginBottom: "var(--s-6)" }}>
              {visibleCatalog.map((def) => (
                <ConnectorGridCard
                  key={def.id}
                  def={def}
                  statusEntry={getConnector(def.id)}
                  onConnect={() => handleConnect(def.id)}
                  onDisconnect={() => handleDisconnect(def.id)}
                  onTest={() => handleTest(def.id)}
                  loading={acting === def.id}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Notion token-paste modal */}
      {notionModalOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setNotionModalOpen(false); setNotionToken(""); setNotionErr(null); } }}
        >
          <div className="card" style={{ width: "100%", maxWidth: 420, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <IconNotion />
              <strong style={{ fontSize: 15 }}>Connect Notion</strong>
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-2)", margin: 0 }}>
              Create an internal integration at{" "}
              <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
                notion.so/my-integrations
              </a>
              , copy the integration token, and paste it below. Then share your databases/pages with the integration inside Notion.
            </p>
            <input
              type="password"
              autoFocus
              placeholder="secret_..."
              value={notionToken}
              onChange={(e) => setNotionToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleNotionConnect(); }}
              style={{ fontFamily: "var(--font-mono)", fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--bg-0)", color: "var(--fg-1)", width: "100%", boxSizing: "border-box" }}
            />
            {notionErr && <div className="alert-err" style={{ fontSize: 12 }}>{notionErr}</div>}
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

      {/* Generic token-paste modal */}
      {tokenModal && TOKEN_MODAL_CONNECTORS[tokenModal] && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setTokenModal(null); setTokenValue(""); setTokenErr(null); } }}
        >
          <div className="card" style={{ width: "100%", maxWidth: 440, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {TOKEN_MODAL_CONNECTORS[tokenModal].icon}
              <strong style={{ fontSize: 15 }}>Connect {TOKEN_MODAL_CONNECTORS[tokenModal].name}</strong>
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
              style={{ fontFamily: "var(--font-mono)", fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-subtle)", background: "var(--bg-0)", color: "var(--fg-1)", width: "100%", boxSizing: "border-box" }}
            />
            {tokenErr && <div className="alert-err" style={{ fontSize: 12 }}>{tokenErr}</div>}
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
