const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function apiPath(path: string): string {
  return `${BASE}${path}`;
}

/**
 * A dashboard page URL with the base path applied, for a full-page
 * navigation (`window.location`). Next's <Link>/router add the base path
 * themselves; a raw `window.location.href = "/runs"` does not, so behind
 * `/dashboard` it left the app (audit M29).
 */
export function appHref(path: string): string {
  return `${BASE}${path}`;
}
