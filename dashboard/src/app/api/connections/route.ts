import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface ConnectorStatus {
  id: string;
  status: "connected" | "disconnected";
  lastSync?: string;
}

export interface ConnectionsResponse {
  connectors: ConnectorStatus[];
}

export async function GET(): Promise<Response> {
  const res = await bridgeFetch("/connections");
  if (res.status === 503) {
    return new Response(
      JSON.stringify({ error: "No running bridge found" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  if (!res.ok) {
    // Bridge is up but doesn't know about /connections yet — return defaults.
    const body: ConnectionsResponse = {
      connectors: [{ id: "gmail", status: "disconnected" }],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}
