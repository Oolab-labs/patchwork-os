import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function requireString(
  args: Record<string, unknown>,
  key: string,
  maxLength = 4096,
): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${key} exceeds maximum length of ${maxLength}`);
  }
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength = 4096,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${key} exceeds maximum length of ${maxLength}`);
  }
  return value;
}

export function optionalInt(
  args: Record<string, unknown>,
  key: string,
  min = 1,
  max = 10_000_000,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function optionalBool(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

/** Require args[key] to be an array. Throws on failure. */
export function requireArray(
  args: Record<string, unknown>,
  key: string,
): unknown[] {
  const val = args[key];
  if (!Array.isArray(val)) {
    throw new Error(`${key} must be an array`);
  }
  return val;
}

/** Return args[key] if it is an array, undefined if absent, throw if wrong type. */
export function optionalArray(
  args: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  const val = args[key];
  if (val === undefined) return undefined;
  if (!Array.isArray(val)) {
    throw new Error(`${key} must be an array`);
  }
  return val;
}

// Cache for workspace realpath — short TTL to limit the TOCTOU window if the workspace
// directory itself is replaced with a symlink while the bridge is running.
const REALPATH_CACHE_TTL_MS = 5_000;
const realpathCache = new Map<string, { value: string; expiresAt: number }>();

function cachedRealpathSync(p: string): string {
  const now = Date.now();
  const entry = realpathCache.get(p);
  if (entry !== undefined && now < entry.expiresAt) {
    return entry.value;
  }
  const value = fs.realpathSync(p);
  realpathCache.set(p, { value, expiresAt: now + REALPATH_CACHE_TTL_MS });
  return value;
}

export function resolveFilePath(
  filePath: string,
  workspace: string,
  opts: { write?: boolean } = {},
): string {
  if (typeof filePath !== "string") {
    throw new Error("filePath must be a string");
  }
  if (filePath.includes("\x00")) {
    throw new Error("filePath must not contain null bytes");
  }
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspace, filePath);
  const normalizedWorkspace = path.resolve(workspace);
  if (
    resolved !== normalizedWorkspace &&
    !resolved.startsWith(normalizedWorkspace + path.sep)
  ) {
    const err = new Error(
      `Path "${filePath}" escapes workspace "${workspace}". All paths must be within the workspace.`,
    ) as Error & { code: string };
    err.code = "workspace_escape";
    throw err;
  }
  try {
    const realWorkspace = cachedRealpathSync(normalizedWorkspace);
    // For symlink resolution, try the file first, then its parent
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(resolved);
    } catch {
      // File doesn't exist yet — resolve parent directory
      const parentDir = path.dirname(resolved);
      try {
        realTarget = path.join(
          fs.realpathSync(parentDir),
          path.basename(resolved),
        );
      } catch {
        // Parent doesn't exist either — trust the path.resolve check above
        return resolved;
      }
    }
    if (
      realTarget !== realWorkspace &&
      !realTarget.startsWith(realWorkspace + path.sep)
    ) {
      throw new Error(`Path "${filePath}" escapes workspace via symlink`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("escapes workspace"))
      throw err;
    // Deny by default when symlink resolution fails unexpectedly (ELOOP, EACCES, etc.)
    // to prevent symlink-based workspace escape
    throw new Error(
      `Cannot verify path "${filePath}" is within workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Hardlink bypass guard: on write paths, reject files with multiple directory
  // entries pointing at the same inode. A hardlink from inside the workspace to
  // an outside file shares an inode and passes the realpath check above, but
  // writing through it would modify the outside file.
  // Directories are excluded — their nlink reflects subdirectory count, not hardlinks.
  if (opts.write) {
    try {
      const lst = fs.lstatSync(resolved);
      if (!lst.isDirectory() && lst.nlink > 1) {
        const hlErr = new Error(
          `Path "${filePath}" is a hardlink (nlink=${lst.nlink}) — write denied to prevent workspace escape`,
        ) as Error & { code: string };
        hlErr.code = "workspace_escape";
        throw hlErr;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("hardlink")) throw err;
      // File doesn't exist yet (ENOENT) — safe to create; other lstat errors are non-fatal
    }
  }

  return resolved;
}

export async function findLineNumber(
  filePath: string,
  text: string,
): Promise<number | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.includes(text)) return i + 1;
    }
  } catch {
    // file not readable
  }
  return null;
}

export function success(data: unknown): {
  content: Array<{ type: string; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function error(
  data: string | Record<string, unknown>,
  code?: string,
): {
  content: Array<{ type: string; text: string }>;
  isError: true;
} {
  let payload: Record<string, unknown>;
  if (typeof data === "string") {
    payload = { error: data };
  } else {
    payload = { ...data };
  }
  if (code !== undefined) payload.code = code;
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function extensionRequired(feature: string) {
  return error(
    `VS Code extension not connected — ${feature} requires the extension`,
    "extension_required",
  );
}

export function requireInt(
  args: Record<string, unknown>,
  key: string,
  min = 1,
  max = 10_000_000,
): number {
  const value = args[key];
  if (
    value === undefined ||
    value === null ||
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function toFileUri(absPath: string): string {
  return new URL(`file://${absPath}`).href;
}

export function truncateOutput(
  str: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return { text: str, truncated: false };
  // Walk back from the cut point to avoid splitting a multi-byte character.
  // UTF-8 continuation bytes have the form 10xxxxxx (0x80–0xBF); skip them.
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  const sliced = buf.subarray(0, end).toString("utf-8");
  return { text: sliced, truncated: true };
}

export interface ExecSafeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export async function execSafe(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    stdin?: string;
  } = {},
): Promise<ExecSafeResult> {
  const timeout = opts.timeout ?? 30_000;
  const maxBuffer = opts.maxBuffer ?? 512 * 1024;
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout,
      maxBuffer,
      signal: opts.signal,
      ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
    });
    return {
      stdout,
      stderr,
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const e = err as {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    const isMaxBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    const timedOut =
      !isMaxBuffer &&
      (e.code === "ABORT_ERR" ||
        (e.killed === true && durationMs >= timeout * 0.9));
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      exitCode: e.status ?? 1,
      timedOut,
      durationMs,
    };
  }
}

export const LANGUAGE_ID_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".md": "markdown",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".toml": "toml",
};

export function languageIdFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_ID_MAP[ext] || "plaintext";
}

const MIME_BY_EXT: Record<string, string> = {
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "text/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/plain",
  ".less": "text/plain",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".sql": "text/x-sql",
  ".toml": "text/x-toml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

export function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "text/plain";
}

export function makeRelative(absPath: string, workspace: string): string {
  return absPath.startsWith(workspace + path.sep)
    ? absPath.slice(workspace.length + 1)
    : absPath;
}
