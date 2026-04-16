/**
 * Branded types for path safety.
 *
 * AbsPath — an absolute filesystem path (string brand)
 * FileUri — a file:// URI derived from an AbsPath (string brand)
 *
 * Using branded types prevents accidental mixing of relative paths, URIs, and
 * absolute paths at compile time.  At runtime the values are plain strings —
 * no overhead.
 */

import * as path from "node:path";

// ── Brand declarations ────────────────────────────────────────────────────────

export type AbsPath = string & { readonly _brand: "AbsPath" };
export type FileUri = string & { readonly _brand: "FileUri" };

// ── Constructors ──────────────────────────────────────────────────────────────

/**
 * Assert that `p` is an absolute path and return it as `AbsPath`.
 * Throws if `p` is relative.
 */
export function absPath(p: string): AbsPath {
  if (!path.isAbsolute(p)) {
    throw new Error(`Expected absolute path, got: ${p}`);
  }
  return p as AbsPath;
}

/**
 * Convert an `AbsPath` to a `file://` URI.
 * Uses `new URL()` for correct encoding (handles spaces, unicode, etc.).
 */
export function fileUri(p: AbsPath): FileUri {
  return new URL(`file://${p}`).href as FileUri;
}

/**
 * Strip the `file://` prefix from a `FileUri` and return an `AbsPath`.
 * Handles both `file:///path` (URL-encoded) and plain `file:///path` forms.
 * Uses `decodeURIComponent` to restore percent-encoded characters (spaces, etc.).
 */
export function uriToAbsPath(uri: FileUri): AbsPath {
  // URL constructor decodes percent-encoding in pathname on most runtimes, but
  // not all.  Use decodeURIComponent for a guaranteed round-trip.
  const pathname = new URL(uri).pathname;
  return decodeURIComponent(pathname) as AbsPath;
}
