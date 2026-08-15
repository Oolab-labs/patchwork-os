/**
 * Display labels for OAuth connector slugs.
 *
 * A map rather than a derivation, because these cannot be computed from the
 * slug: `github` → "GitHub" and `gitlab` → "GitLab" both defeat title-casing,
 * and guessing wrong puts a misspelt vendor name in front of the operator at
 * the exact moment they are deciding whether to trust a redirect.
 *
 * Extracted when the 13 per-connector callback page directories collapsed into
 * one dynamic route. Each of those directories held a four-line file whose only
 * content was the pair below.
 *
 * NOT unified with the connector catalogue in `app/connections/page.tsx`. That
 * list carries icons, brand colours, categories and tool counts for the
 * connection-picker UI; merging the two would drag React component imports
 * into a module a server route needs, and the shared part is a single string.
 * The duplication is two words per connector, and it is deliberate.
 *
 * Keys are the callback slugs — the same ids the bridge's `oauthConnectorIds()`
 * returns and the same ones that appear in `/connections/<slug>/callback`.
 */
export const CONNECTOR_LABELS: Record<string, string> = {
  asana: "Asana",
  discord: "Discord",
  github: "GitHub",
  gitlab: "GitLab",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-docs": "Google Docs",
  "google-drive": "Google Drive",
  linear: "Linear",
  monday: "Monday",
  salesforce: "Salesforce",
  sentry: "Sentry",
  slack: "Slack",
};
