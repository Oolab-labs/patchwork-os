export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected" | "needs_reauth";
  lastSync?: string;
  /**
   * ISO timestamp of OAuth token expiry, when the connector tracks one.
   * Absent for PAT/API-token connectors (Jira, Confluence, Linear, Notion,
   * HubSpot, Intercom, Datadog, PagerDuty, Zendesk, Sentry, etc.) — never
   * fabricated. See src/connectors/baseConnector.ts `ConnectorStatus`.
   */
  tokenExpiresAt?: string;
  /**
   * ISO timestamp of the most recent successful API call this bridge
   * process observed for this connector. Absent if none recorded yet
   * (never called, or bridge restarted since) — never fabricated.
   */
  lastSuccessAt?: string;
}
