/**
 * Outbound fetch for connectors whose base URL the operator supplies
 * (grafana, posthog, supabase, woocommerce, caldiy). Audit M20, owner
 * decision 2026-10-17: these go through `safeFetch`, the one outbound guard,
 * with private networks ALLOWED — a self-hosted instance commonly lives on
 * a private network, and the operator chose that URL.
 *
 * What the guard still does here: the connection is pinned to the address
 * resolved for the request; an unresolvable name is refused rather than
 * re-resolved by the transport; every redirect hop is re-validated; and a
 * redirect to another origin drops credential headers (`Authorization`,
 * `apikey`, `x-api-key`, cookies). Native fetch drops only `Authorization`,
 * so without this a Supabase service-role key followed a redirect anywhere.
 */

import { isIP } from "node:net";
import { safeFetch } from "../ssrfGuard.js";

/**
 * Test-only DNS: set by the vitest setup file so connector tests never reach
 * real DNS (their hostnames are invented, and a test that passed because a
 * real name happened to resolve was a network dependency). Read per call, so
 * it survives `vi.resetModules()`. In production it is never set; if it
 * were, requests would go to the wrong address and fail — it cannot widen
 * what is reachable.
 */
async function testDns(hostname: string): Promise<string> {
  if (isIP(hostname)) return hostname;
  if (hostname === "localhost") return "127.0.0.1";
  return "203.0.113.10"; // RFC 5737 documentation address
}

export async function connectorFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : Array.isArray(init.headers)
        ? Object.fromEntries(init.headers)
        : (init.headers as Record<string, string> | undefined);
  const { response } = await safeFetch(
    url,
    { ...init, ...(headers && { headers }) } as Parameters<typeof safeFetch>[1],
    {
      allowPrivate: true,
      ...(process.env.PATCHWORK_TEST_STUB_CONNECTOR_DNS === "1" && {
        resolveDns: testDns,
      }),
    },
  );
  return response;
}
