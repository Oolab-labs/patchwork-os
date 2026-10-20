import { safeOAuthErrorCode } from "./oauthError.js";
import { tokenRefreshSignal } from "./tokenRefreshTimeout.js";

/**
 * The refresh-token exchange shared by every Google connector (gmail,
 * calendar, drive, docs). It was four copies of one function, and all four
 * had the same two defects (Private/52 LOW):
 *
 *  - a NEW `refresh_token` in the response was ignored and the old one saved
 *    back, so once Google retired the old token the connector could never
 *    refresh again;
 *  - `invalid_grant` (access revoked, or the token expired) threw but left the
 *    dead tokens stored, so the connector still looked connected and every
 *    call retried a refresh that cannot succeed.
 *
 * Only `invalid_grant` clears. A 401 `invalid_client` means the CLIENT
 * credentials are wrong — a configuration problem — and clearing then would
 * destroy a refresh token that is still good.
 */

export interface GoogleRefreshableTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
}

export async function refreshGoogleTokens<T extends GoogleRefreshableTokens>(
  tokens: T,
  clientId: string,
  clientSecret: string,
  store: { save: (t: T) => void; clear: () => void },
): Promise<T> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: tokenRefreshSignal(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    const code = safeOAuthErrorCode(await res.text().catch(() => ""));
    if (code === "invalid_grant") store.clear();
    throw new Error(`Token refresh failed: ${res.status} (${code})`);
  }
  const json = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: number;
  };
  if (typeof json.access_token !== "string" || json.access_token.length === 0)
    throw new Error("Token refresh returned no access_token");
  const updated: T = {
    ...tokens,
    access_token: json.access_token,
    expiry_date: json.expires_in
      ? Date.now() + json.expires_in * 1000
      : tokens.expiry_date,
    ...(typeof json.refresh_token === "string" && json.refresh_token.length > 0
      ? { refresh_token: json.refresh_token }
      : {}),
  };
  store.save(updated);
  return updated;
}
