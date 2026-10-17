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
  /** When the stored credential was connected, as the connector recorded it. */
  connectedAt?: string;
  /** Account or workspace label stored at connect time. */
  account?: string;
  /** When a Test (or the connect flow) last proved the credential. */
  verifiedAt?: string;
  /** Outcome of the most recent connection Test. */
  lastCheck?: { at: string; ok: boolean; reason?: "failed" | "error" };
  /**
   * Whether the credential has been PROVEN to work. `status: "connected"`
   * only means one is stored. Absent from an older bridge — render nothing
   * rather than guess (audit H9).
   */
  verification?: "verified" | "failed" | "unverified";
}
