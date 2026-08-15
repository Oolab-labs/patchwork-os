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
  // Identify the source env var so a misconfiguration produces an actionable
  // error rather than a silently-broken redirect_uri (audit 2026-06-08
  // connectors-core-8). `??` would treat an empty string as "set", so an
  // accidentally-empty var still surfaces a clear error below.
  const source =
    process.env.PATCHWORK_DASHBOARD_URL !== undefined
      ? "PATCHWORK_DASHBOARD_URL"
      : process.env.PATCHWORK_BRIDGE_URL !== undefined
        ? "PATCHWORK_BRIDGE_URL"
        : "callback base URL";
  const raw = (
    process.env.PATCHWORK_DASHBOARD_URL ??
    process.env.PATCHWORK_BRIDGE_URL ??
    `http://localhost:${port}`
  ).trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${source} must be an http(s) URL, got "${parsed.protocol}" in ${JSON.stringify(raw)}`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Build the OAuth `redirect_uri` for a connector. `connector` is the connector
 * slug as it appears in the callback route, e.g. `slack`, `google-calendar`.
 */
export function connectorRedirectUri(connector: string): string {
  return `${connectorCallbackBase()}/connections/${connector}/callback`;
}

let _portMismatchWarned = false;

/** Test seam — resets the once-only warning. */
export function _resetPortMismatchWarning(): void {
  _portMismatchWarned = false;
}

/**
 * Warn once when the bridge's bound port disagrees with the port every OAuth
 * `redirect_uri` will name.
 *
 * ## Why detect rather than substitute
 *
 * The obvious fix — emit the port we actually bound — is worse. A
 * `redirect_uri` must be REGISTERED with the OAuth app in advance, so a
 * value derived from an OS-assigned port is guaranteed to be rejected by the
 * provider. That produces a URI that is accurate about this process and
 * unusable, and sends the operator to debug the vendor instead of their own
 * port configuration.
 *
 * Local OAuth therefore REQUIRES a pinned port. The fallback's job is to name
 * the port the operator is told to pin (3101 by convention here); this
 * function's job is to say so out loud when reality has diverged from it.
 *
 * ## Scope
 *
 * Only fires on the FALLBACK. When `PATCHWORK_DASHBOARD_URL` or
 * `PATCHWORK_BRIDGE_URL` is set, the operator has stated where the callback
 * is served, and a differing bridge port is not merely allowed but expected —
 * a dashboard on :3200 fronting a bridge on :3101 is the documented topology.
 * Warning there would be noise on a correct configuration.
 *
 * Follows `warnIfLegacyConfigStranded`: warn on positive evidence of a
 * divergence, never on a bare default.
 */
export function warnIfCallbackPortMismatch(
  boundPort: number,
  log: (msg: string) => void = console.warn,
): void {
  if (_portMismatchWarned) return;
  if (
    process.env.PATCHWORK_DASHBOARD_URL !== undefined ||
    process.env.PATCHWORK_BRIDGE_URL !== undefined
  ) {
    return;
  }
  let base: string;
  try {
    base = connectorCallbackBase();
  } catch {
    // A malformed base is already reported, loudly, by the call that builds a
    // redirect_uri. Not this function's failure to re-report.
    return;
  }
  let advertised: number;
  try {
    advertised = Number(new URL(base).port || "80");
  } catch {
    return;
  }
  if (advertised === boundPort) return;

  _portMismatchWarned = true;
  log(
    `[patchwork] OAuth callbacks advertise ${base}/connections/<name>/callback, ` +
      `but this bridge is listening on port ${boundPort}. Every OAuth redirect ` +
      `will land on port ${advertised} and fail.\n` +
      `  A redirect_uri must be registered with each provider in advance, so it ` +
      `cannot simply follow an OS-assigned port — pin the bridge instead:\n` +
      `    patchwork start --port ${advertised}\n` +
      `  or set PATCHWORK_BRIDGE_URL / PATCHWORK_DASHBOARD_URL to the address ` +
      `you registered.`,
  );
}
