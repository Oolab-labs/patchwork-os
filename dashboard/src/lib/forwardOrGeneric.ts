/**
 * Shared helper for dashboard proxy routes — see issue #600.
 *
 * Bridge upstream responses may contain internal details (host:port,
 * filesystem paths, stack frames) that must not be echoed to the
 * dashboard client. This helper enforces the convention used by all
 * hardened proxy routes:
 *
 *   - 2xx: forward body + content-type verbatim.
 *   - non-2xx: log the upstream body server-side (truncated), then
 *              return a generic `{ error: "Bridge returned <status>" }`
 *              shape with the same status code.
 *
 * Keep this shape in sync with the catch-block fallback used across
 * proxy routes: `{ error: "Bridge unreachable" }` at status 502.
 */
export async function forwardOrGeneric(
  res: Response,
  context: string,
): Promise<Response> {
  if (res.ok) {
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "content-type":
          res.headers.get("content-type") ?? "application/json",
      },
    });
  }
  let snippet = "";
  try {
    snippet = (await res.text()).slice(0, 500);
  } catch {
    /* body already consumed or unreadable — ignore */
  }
  console.error(`[${context}] bridge returned ${res.status}:`, snippet);
  return new Response(
    JSON.stringify({ error: `Bridge returned ${res.status}` }),
    {
      status: res.status,
      headers: { "content-type": "application/json" },
    },
  );
}
