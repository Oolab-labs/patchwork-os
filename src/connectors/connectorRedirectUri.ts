/**
 * OAuth redirect-URI derivation — shared by every OAuth connector.
 *
 * The OAuth provider redirects the browser to this URL to finish the flow.
 * The dashboard serves `/connections/<name>/callback` (under its basePath, if
 * any) and forwards the `code` / `state` to the bridge. Centralising the
 * derivation here keeps every connector's `redirect_uri` consistent — a
 * mismatch against the value registered on the OAuth app is the single most
 * common cause of a failed authorization.
 *
 * Base-URL precedence:
 *
 *   1. `PATCHWORK_DASHBOARD_URL` — the dashboard's public base URL. Set this
 *      whenever a dashboard fronts the bridge; the value must already include
 *      the dashboard's basePath (e.g. `https://example.com/dashboard`).
 *   2. `PATCHWORK_BRIDGE_URL` — the bridge's own public base URL, when the
 *      bridge serves the callback directly with no dashboard in front.
 *   3. `http://localhost:<PATCHWORK_BRIDGE_PORT|3101>` — local-dev fallback.
 *
 * A single registered callback URL therefore covers every connector for a
 * given deployment: set `PATCHWORK_DASHBOARD_URL` and register
 * `<that base>/connections/<name>/callback` on each OAuth app.
 */

/** Resolve the public base URL the OAuth callback is served from. */
export function connectorCallbackBase(): string {
  const port = process.env.PATCHWORK_BRIDGE_PORT ?? "3101";
  return (
    process.env.PATCHWORK_DASHBOARD_URL ??
    process.env.PATCHWORK_BRIDGE_URL ??
    `http://localhost:${port}`
  ).replace(/\/+$/, "");
}

/**
 * Build the OAuth `redirect_uri` for a connector. `connector` is the connector
 * slug as it appears in the callback route, e.g. `slack`, `google-calendar`.
 */
export function connectorRedirectUri(connector: string): string {
  return `${connectorCallbackBase()}/connections/${connector}/callback`;
}
