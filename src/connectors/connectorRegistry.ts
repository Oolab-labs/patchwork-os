/**
 * Single source of truth for the connector roster.
 *
 * Both the bridge (this package) and the dashboard import from here. Adding
 * a connector means one line in CONNECTORS below — the four dashboard
 * allowlists (auth / connect / test / DELETE) and the bridge's connections
 * list endpoint derive their membership from this table.
 *
 * Six OAuth connectors silently broke end-to-end (PR #777) because the
 * dashboard allowlists drifted from the bridge routes. Don't reintroduce
 * that class of bug — edit this file, not the per-route Sets.
 *
 * Zero runtime dependencies on purpose — the dashboard imports this file
 * via relative path; it must compile under both the bridge tsconfig
 * (NodeNext + verbatimModuleSyntax + noUncheckedIndexedAccess) and the
 * dashboard tsconfig (bundler resolution).
 */

export type ConnectorAuthKind = "oauth" | "pat";

export interface ConnectorCapabilities {
  /** Connector supports the OAuth `GET /connections/<id>/auth` redirect. */
  readonly auth?: boolean;
  /** Connector supports the PAT `POST /connections/<id>/connect` paste flow. */
  readonly connect?: boolean;
  /** Connector supports the `POST /connections/<id>/test` health probe. */
  readonly test?: boolean;
  /** Connector supports `DELETE /connections/<id>` to revoke. */
  readonly delete?: boolean;
}

export interface ConnectorDescriptor {
  readonly id: string;
  readonly label: string;
  readonly authKind: ConnectorAuthKind;
  readonly supports: ConnectorCapabilities;
}

/**
 * Membership notes (preserved verbatim from the four pre-consolidation
 * Sets; do NOT widen or narrow without a paired dashboard test).
 *
 * - `auth` allowlist historically includes some PAT connectors too. The
 *   bridge returns the correct error for those; the dashboard route is
 *   permissive on purpose. Keep parity.
 * - `connect` allowlist is the narrow PAT-only set.
 * - `test` and `delete` allowlists are identical and cover every
 *   connector that has a corresponding bridge route.
 * - `jira` is intentionally absent from the dashboard surfaces today
 *   (concurrent work is wiring its bridge routes). When that lands,
 *   flip its `supports` flags here and the dashboard picks it up.
 */
export const CONNECTORS: readonly ConnectorDescriptor[] = [
  // OAuth connectors
  {
    id: "gmail",
    label: "Gmail",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "google-drive",
    label: "Google Drive",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "github",
    label: "GitHub",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "linear",
    label: "Linear",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "sentry",
    label: "Sentry",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "slack",
    label: "Slack",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "asana",
    label: "Asana",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "discord",
    label: "Discord",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "gitlab",
    label: "GitLab",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },

  // PAT (token-paste) connectors. `auth: true` mirrors the legacy
  // dashboard auth allowlist (see note above).
  {
    id: "notion",
    label: "Notion",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "confluence",
    label: "Confluence",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "datadog",
    label: "Datadog",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "hubspot",
    label: "HubSpot",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "intercom",
    label: "Intercom",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "stripe",
    label: "Stripe",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "zendesk",
    label: "Zendesk",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  // pagerduty: PAT, but not in legacy `auth` allowlist.
  {
    id: "pagerduty",
    label: "PagerDuty",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // postgres: PAT (connection string / discrete fields). Not in the legacy
  // `auth` allowlist because there is no OAuth redirect to start.
  {
    id: "postgres",
    label: "Postgres",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // mongodb: PAT (connection URI). Lazy-loads the `mongodb` driver.
  {
    id: "mongodb",
    label: "MongoDB",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // redis: PAT (connection URL). Lazy-loads the `redis` driver. Read-only
  // command allowlist enforced inside the connector.
  {
    id: "redis",
    label: "Redis",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // elasticsearch: PAT (node URL + apiKey/basic, or cloudId + apiKey).
  // Lazy-loads the `@elastic/elasticsearch` driver.
  {
    id: "elasticsearch",
    label: "Elasticsearch",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // Wave 1b — PAT comms connectors.
  {
    id: "sendgrid",
    label: "SendGrid",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  {
    id: "twilio",
    label: "Twilio",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // Wave 2 — PAT SaaS connectors (skip Wave 3 OAuth-app connectors for now).
  {
    id: "figma",
    label: "Figma",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  {
    id: "airtable",
    label: "Airtable",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  {
    id: "webflow",
    label: "Webflow",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
  // jira: PAT. Concurrent work is wiring the bridge routes. The
  // `supports` capabilities here are deliberately empty until those
  // routes exist; flipping them in this file is the one-line change
  // that opens jira up to the dashboard surfaces.
  { id: "jira", label: "Jira", authKind: "pat", supports: {} },
];

/** All connector ids — useful for the bridge's list endpoint. */
export function allConnectorIds(): string[] {
  return CONNECTORS.map((c) => c.id);
}

/** Connector ids with `authKind === "oauth"`. */
export function oauthConnectorIds(): string[] {
  return CONNECTORS.filter((c) => c.authKind === "oauth").map((c) => c.id);
}

/** Connector ids with `authKind === "pat"`. */
export function patConnectorIds(): string[] {
  return CONNECTORS.filter((c) => c.authKind === "pat").map((c) => c.id);
}

/** Connector ids supporting `GET /connections/<id>/auth`. */
export function authAllowedConnectorIds(): string[] {
  return CONNECTORS.filter((c) => c.supports.auth === true).map((c) => c.id);
}

/** Connector ids supporting `POST /connections/<id>/connect` (PAT paste). */
export function connectAllowedConnectorIds(): string[] {
  return CONNECTORS.filter((c) => c.supports.connect === true).map((c) => c.id);
}

/** Connector ids supporting `POST /connections/<id>/test`. */
export function testAllowedConnectorIds(): string[] {
  return CONNECTORS.filter((c) => c.supports.test === true).map((c) => c.id);
}

/** Connector ids supporting `DELETE /connections/<id>`. */
export function deleteAllowedConnectorIds(): string[] {
  return CONNECTORS.filter((c) => c.supports.delete === true).map((c) => c.id);
}
