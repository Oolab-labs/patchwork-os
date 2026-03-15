/**
 * MCP resources/ implementation.
 *
 * Exposes workspace files as addressable MCP Resource objects.
 * Security: all paths are workspace-confined (same rules as tools).
 * Does not implement resources/subscribe or resources/templates/list (deferred).
 */
import fs from "node:fs";
import path from "node:path";
import { mimeTypeFromPath } from "./tools/utils.js";

const RESOURCES_PAGE_SIZE = 50;
const MAX_RESOURCE_BYTES = 1 * 1024 * 1024; // 1 MB — same guard as getBufferContent

/** Extensions we emit as resources. Binary files (images, pdfs) are listed but not read as text. */
const TEXT_RESOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".html", ".htm", ".css", ".scss", ".less",
  ".md", ".txt", ".sh", ".bash",
  ".py", ".rb", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp",
  ".sql", ".graphql", ".vue", ".svelte",
  ".gitignore", ".editorconfig",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", "out", ".next", ".nuxt",
  "__pycache__", ".pytest_cache", ".tox",
  "target", ".cargo",
  ".DS_Store",
]);

/** An MCP Resource object. */
export interface McpResource {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
}

/**
 * Recursively enumerate workspace files, skipping common non-source directories.
 * Returns absolute paths sorted lexicographically.
 */
function collectWorkspaceFiles(workspace: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // skip symlinks for security
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }

  walk(workspace);
  results.sort();
  return results;
}

function fileToResource(absPath: string, workspace: string): McpResource {
  const relPath = absPath.startsWith(workspace + path.sep)
    ? absPath.slice(workspace.length + 1)
    : absPath;
  const uri = `file://${absPath}`;
  return {
    uri,
    name: relPath,
    mimeType: mimeTypeFromPath(absPath),
  };
}

export interface ListResourcesResult {
  resources: McpResource[];
  nextCursor?: string;
}

// Simple in-memory snapshot to avoid re-walking the filesystem on every paginated call.
// Invalidated after 5 seconds so the list stays reasonably fresh without constant I/O.
// Keyed by workspace path so multi-root sessions don't share or evict each other's cache.
const WALK_CACHE_TTL_MS = 5_000;
const walkCache = new Map<string, { files: string[]; expiresAt: number }>();

function getCachedWorkspaceFiles(workspace: string): string[] {
  const now = Date.now();
  const cached = walkCache.get(workspace);
  if (cached && now < cached.expiresAt) {
    return cached.files;
  }
  const files = collectWorkspaceFiles(workspace);
  walkCache.set(workspace, { files, expiresAt: now + WALK_CACHE_TTL_MS });
  return files;
}

/** Invalidate the walk cache (useful in tests when files are added mid-run). */
export function invalidateResourcesCache(workspace?: string): void {
  if (workspace) {
    walkCache.delete(workspace);
  } else {
    walkCache.clear();
  }
}

/**
 * List workspace files as MCP resources, with cursor-based pagination.
 * Cursor is an opaque base64-encoded decimal offset (same pattern as tools/list).
 */
export function listResources(workspace: string, cursor?: string): ListResourcesResult {
  const allFiles = getCachedWorkspaceFiles(workspace);

  let offset = 0;
  if (typeof cursor === "string") {
    try {
      const decoded = Number.parseInt(
        Buffer.from(cursor, "base64").toString("utf-8"),
        10,
      );
      if (Number.isFinite(decoded) && decoded >= 0) offset = decoded;
    } catch {
      // malformed cursor — start from beginning
    }
  }

  const page = allFiles.slice(offset, offset + RESOURCES_PAGE_SIZE);
  const nextOffset = offset + RESOURCES_PAGE_SIZE;
  const hasMore = nextOffset < allFiles.length;
  const nextCursor = hasMore
    ? Buffer.from(String(nextOffset)).toString("base64")
    : undefined;

  return {
    resources: page.map((f) => fileToResource(f, workspace)),
    ...(nextCursor !== undefined && { nextCursor }),
  };
}

export type ReadResourceResult =
  | { contents: Array<{ uri: string; text: string; mimeType: string }> }
  | { error: string; code: string };

/**
 * Read a workspace file by URI.
 * Returns an error object if the file is outside the workspace, too large, or unreadable.
 */
export function readResource(workspace: string, uri: string): ReadResourceResult {
  // Accept file:// URIs only
  if (!uri.startsWith("file://")) {
    return { error: "Only file:// URIs are supported", code: "invalid_args" };
  }

  // Decode percent-encoding before resolving — paths with spaces are encoded
  // as "file:///my%20dir/file.ts" and must be decoded or the workspace check fails.
  let rawPath: string;
  try {
    rawPath = decodeURIComponent(uri.slice(7)); // strip "file://" then decode
  } catch {
    return { error: `URI "${uri}" contains invalid percent-encoding`, code: "invalid_args" };
  }
  const absPath = path.resolve(rawPath);
  const normalizedWorkspace = path.resolve(workspace);

  // Workspace confinement
  if (
    absPath !== normalizedWorkspace &&
    !absPath.startsWith(normalizedWorkspace + path.sep)
  ) {
    return { error: `URI "${uri}" is outside the workspace`, code: "workspace_escape" };
  }

  // Stat to check size — use lstatSync so symlinks are not followed
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absPath);
  } catch {
    return { error: `Resource not found: ${uri}`, code: "file_not_found" };
  }

  // Reject symlinks — listing already skips them; read must too
  if (stat.isSymbolicLink()) {
    return { error: `URI "${uri}" is a symlink — not supported`, code: "invalid_args" };
  }

  if (!stat.isFile()) {
    return { error: `URI "${uri}" is not a file`, code: "invalid_args" };
  }

  if (stat.size > MAX_RESOURCE_BYTES) {
    return {
      error: `Resource "${uri}" is too large (${stat.size} bytes > ${MAX_RESOURCE_BYTES} byte limit)`,
      code: "resource_too_large",
    };
  }

  const ext = path.extname(absPath).toLowerCase();
  if (!TEXT_RESOURCE_EXTS.has(ext)) {
    return {
      error: `Resource "${uri}" has a binary or unsupported extension "${ext}"`,
      code: "invalid_args",
    };
  }

  let text: string;
  try {
    text = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    return {
      error: `Failed to read resource: ${err instanceof Error ? err.message : String(err)}`,
      code: "permission_denied",
    };
  }

  return {
    contents: [
      {
        uri,
        text,
        mimeType: mimeTypeFromPath(absPath),
      },
    ],
  };
}
