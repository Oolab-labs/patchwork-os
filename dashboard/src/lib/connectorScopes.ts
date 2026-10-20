/**
 * What each connection card says Patchwork can do with it.
 *
 * These are CAPABILITY LABELS, not a record of OAuth scopes requested: several
 * of these connectors authenticate with an API token, where there is no scope
 * to report, and some strings below are not real provider scopes at all.
 * What they must never do is understate. Eight cards (github, asana, discord,
 * zendesk, intercom, hubspot, pagerduty, datadog) said only "Read …" while
 * the connector registers write tools (Private/52 LOW) — a card telling an
 * operator a connection is read-only is a stronger promise than no card.
 *
 * `connectorScopes.test.ts` loads the bridge's real tool registry and fails
 * when a connector with any `isWrite` tool has no chip in `WRITE_SCOPES`.
 */

export const CONNECTOR_SCOPES: Record<string, string[]> = {
  slack: ["channels:read", "chat:write", "users:read"],
  jira: ["read:jira", "write:jira"],
  confluence: ["read:confluence", "write:confluence"],
  github: ["repo:read", "issues:read", "pulls:read", "issues:write"],
  gitlab: ["read_api", "read_repository"],
  linear: ["read", "write"],
  asana: ["tasks:read", "projects:read", "tasks:write"],
  notion: ["read_content", "update_content"],
  discord: ["messages.read", "guilds.read", "messages.write"],
  zendesk: ["tickets:read", "users:read", "tickets:write"],
  intercom: ["conversations:read", "users:read", "conversations:write"],
  hubspot: ["contacts:read", "deals:read", "notes:write"],
  pagerduty: ["incidents:read", "services:read", "incidents:write"],
  datadog: ["monitors_read", "events_read", "monitors_write"],
  stripe: ["read_only"],
  sentry: ["event:read", "project:read"],
  gmail: ["gmail.readonly"],
  "google-calendar": ["calendar.readonly"],
  "google-drive": ["drive.readonly"],
  telegram: ["send_messages", "read_chats"],
};

/** Chips that say the connection can CHANGE something. */
export const WRITE_SCOPES = new Set<string>([
  "chat:write",
  "write:jira",
  "write:confluence",
  "write",
  "update_content",
  "send_messages",
  "issues:write",
  "tasks:write",
  "messages.write",
  "tickets:write",
  "conversations:write",
  "notes:write",
  "incidents:write",
  "monitors_write",
]);

/** Plain-English chip labels. */
export const SCOPE_TRANSLATIONS: Record<string, string> = {
  "channels:read": "See channels",
  "chat:write": "Send messages",
  "users:read": "See user info",
  "read:jira": "Read Jira issues",
  "write:jira": "Write Jira issues",
  "read:confluence": "Read Confluence pages",
  "write:confluence": "Write Confluence pages",
  "repo:read": "Read code & issues",
  "issues:read": "Read issues",
  "issues:write": "Create issues",
  "pulls:read": "Read pull requests",
  read_api: "Read repository data",
  read_repository: "Read repository data",
  read: "Read your data",
  write: "Write your data",
  "tasks:read": "Read tasks",
  "tasks:write": "Create & update tasks",
  "projects:read": "Read projects",
  read_content: "Read pages",
  update_content: "Edit pages",
  "messages.read": "Read messages",
  "messages.write": "Send messages",
  "guilds.read": "See servers",
  "tickets:read": "Read tickets",
  "tickets:write": "Comment on & update tickets",
  "conversations:read": "Read conversations",
  "conversations:write": "Reply to & close conversations",
  "contacts:read": "Read contacts",
  "deals:read": "Read deals",
  "notes:write": "Create notes",
  "incidents:read": "Read incidents",
  "incidents:write": "Create, acknowledge & resolve incidents",
  "services:read": "Read services",
  monitors_read: "Read monitors",
  monitors_write: "Mute monitors",
  events_read: "Read events",
  read_only: "Read-only access",
  "event:read": "Read error events",
  "project:read": "Read project info",
  "gmail.readonly": "Read email",
  "calendar.readonly": "Read calendar",
  "drive.readonly": "Read files",
  send_messages: "Send messages",
  read_chats: "Read chats",
};
