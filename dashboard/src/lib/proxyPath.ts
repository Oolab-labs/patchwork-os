/**
 * Rebuild an upstream path from DECODED Next.js route params.
 *
 * Next decodes dynamic-segment values before a route handler sees them. That
 * is right for reading a name, and wrong for putting it back on the wire: a
 * request for `/api/bridge/recipes%2Finstall` is ONE segment to the router —
 * so the static `recipes/install` route (which needs a literal slash) does not
 * match and the catch-all gets it — but the handler receives the string
 * "recipes/install", and `segments.join("/")` then sends the bridge
 * `/recipes/install`: two segments, a different endpoint, and one whose
 * dedicated proxy carried a rate limit and a source validator that were never
 * consulted. Confirmed against `next dev` 2026-10-01. The same join turned a
 * decoded `?` into a real query separator.
 *
 * Re-encoding each segment restores exactly the path the client sent. For
 * every legitimate caller this is a no-op — recipe names are `[a-z0-9-]`, run
 * ids are hex — and the bridge `decodeURIComponent`s names on its side anyway.
 * No allow-list is needed: the bridge simply 404s `/recipes%2Finstall`.
 *
 * One helper for every proxy that joins params, because the `[...name]` route
 * had a variable literally called `encodedName` that was not encoded.
 */
export function joinPathSegments(segments: readonly string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}
