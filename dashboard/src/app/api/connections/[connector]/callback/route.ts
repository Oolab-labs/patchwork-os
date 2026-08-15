import { bridgeFetch } from "@/lib/bridge";
import { oauthConnectorIds } from "../../../../../../../src/connectors/connectorRegistry";
import { requireCallbackSession } from "../../requireSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OAuth callback proxy, for every connector.
 *
 * Replaces 13 near-identical `api/connections/<slug>/callback/route.ts` files.
 * They had already DRIFTED — differing comments and quote styles between
 * copies — which is the concrete version of the risk duplication carries: a
 * fix applied to one and not the others, with nothing to notice.
 *
 * Follows the shape the sibling `[connector]/auth` route established: derive
 * the allowlist from the registry, 404 anything outside it. `oauthConnectorIds()`
 * had zero call sites in the whole repo before this.
 */
const ALLOWED = new Set(oauthConnectorIds());

export async function GET(
  req: Request,
  ctx: { params: Promise<{ connector: string }> },
): Promise<Response> {
  const { connector } = await ctx.params;
  // Checked BEFORE the session gate. An unrecognised slug is a routing fact,
  // not an authorization one, and reporting it as 401 is what sends an
  // operator to debug credentials after a typo in a registered redirect_uri.
  if (!ALLOWED.has(connector)) {
    return new Response(
      JSON.stringify({ error: `Unknown connector "${connector}"` }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  // LOW #39: verify active dashboard session before forwarding OAuth code.
  const authErr = await requireCallbackSession(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const allowed = ["code", "state", "error"];
  const qs = new URLSearchParams();
  for (const key of allowed) {
    const v = url.searchParams.get(key);
    if (v !== null) qs.set(key, v);
  }

  try {
    const res = await bridgeFetch(
      `/connections/${connector}/callback?${qs.toString()}`,
    );
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type":
          res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error(
      `[connections/${connector}/callback GET] bridge fetch failed:`,
      err,
    );
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
