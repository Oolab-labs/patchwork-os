import { bridgeFetch } from "@/lib/bridge";
import { forwardOrGeneric } from "@/lib/forwardOrGeneric";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteAllowedConnectorIds } from "../../../../../../src/connectors/connectorRegistry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED = new Set(deleteAllowedConnectorIds());

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ connector: string }> },
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const { connector } = await ctx.params;
  if (!ALLOWED.has(connector)) {
    return new Response(JSON.stringify({ error: "Unknown connector" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  try {
    const res = await bridgeFetch(`/connections/${connector}`, {
      method: "DELETE",
    });
    return await forwardOrGeneric(res, `connections/${connector} DELETE`);
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error(`[connections/${connector} DELETE] bridge fetch failed:`, err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
