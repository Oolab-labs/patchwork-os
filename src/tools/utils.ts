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

// No caching for workspace realpath — a stale cache creates a TOCTOU window
// where a symlink swap of the workspace directory could allow path traversal
// outside the workspace. The overhead of realpathSync is negligible relative
// to the file I/O that follows each resolveFilePath call.
function cachedRealpathSync(p: string): string {
  return fs.realpathSync(p);
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
      `Path "${filePath}" (resolved: "${resolved}") escapes workspace "${workspace}". All paths must be within the workspace.`,
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
      // File doesn't exist yet — walk up ancestors until we find one that exists,
      // then reconstruct the logical path below it. This prevents a symlink at
      // any ancestor level (e.g. workspace/link/nonexistent/file) from bypassing
      // the containment check when the immediate parent doesn't exist yet.
      let ancestor = path.dirname(resolved);
      const suffix = [path.basename(resolved)];
      let realAncestor: string | null = null;
      while (ancestor !== path.dirname(ancestor)) {
        try {
          realAncestor = fs.realpathSync(ancestor);
          break;
        } catch {
          suffix.unshift(path.basename(ancestor));
          ancestor = path.dirname(ancestor);
        }
      }
      if (realAncestor === null) {
        // Reached filesystem root without finding any real ancestor on disk.
        // This means the entire path (including the workspace root) doesn't
        // exist or is inaccessible. Fail closed rather than open — returning
        // `resolved` here would skip the symlink containment check entirely.
        throw new Error(
          `Cannot verify path "${filePath}" is within workspace: no real ancestor found`,
        );
      }
      realTarget = path.join(realAncestor, ...suffix);
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

/**
 * Like `success()` but also emits `structuredContent` per MCP 2025-06-18 spec.
 * Use for tools that declare `outputSchema` — enables reliable tool chaining
 * without clients having to parse text blobs.
 */
export function successStructured(data: unknown): {
  content: Array<{ type: string; text: string }>;
  structuredContent: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/**
 * Maximum chars that Claude Code will persist for a tool result when annotated.
 * Without the annotation, results may be silently truncated by the client.
 * See Claude Code v2.1.91 changelog: `_meta["anthropic/maxResultSizeChars"]`.
 */
const MAX_RESULT_SIZE_CHARS = 500_000;

/**
 * Like `success()` but annotates the content block with
 * `_meta["anthropic/maxResultSizeChars"]` so Claude Code persists up to 500K
 * chars instead of applying its default truncation. Use for tools that return
 * large outputs (file contents, diffs, search results, dependency trees).
 */
export function successLarge(data: unknown): {
  content: Array<{
    type: string;
    text: string;
    _meta?: Record<string, unknown>;
  }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
        _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_SIZE_CHARS },
      },
    ],
  };
}

/**
 * Like `successStructured()` but with the large-result `_meta` annotation.
 */
export function successStructuredLarge(data: unknown): {
  content: Array<{
    type: string;
    text: string;
    _meta?: Record<string, unknown>;
  }>;
  structuredContent: unknown;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
        _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_SIZE_CHARS },
      },
    ],
    structuredContent: data,
  };
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

export function extensionRequired(feature: string, alternatives?: string[]) {
  let msg = `VS Code extension not connected — ${feature} requires the extension.\n\nTo reconnect: Cmd+Shift+P → "Claude IDE Bridge: Reconnect"`;
  if (alternatives?.length) {
    msg += `\n\nAlternatives that work without the extension:\n${alternatives.map((a) => `  • ${a}`).join("\n")}`;
  }
  return error(msg, "extension_required");
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
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ExecSafeResult> {
  const timeout = opts.timeout ?? 30_000;
  const maxBuffer = opts.maxBuffer ?? 512 * 1024;
  const start = Date.now();
  try {
    // Use a minimal environment by default to prevent subprocess access to
    // secrets inherited from the bridge process (ANTHROPIC_API_KEY, DB creds, etc.).
    // Callers may pass opts.env to extend or override specific vars.
    const minimalEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      // Node/npm toolchain vars needed by most build commands
      NVM_DIR: process.env.NVM_DIR,
      NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX,
      NODE_PATH: process.env.NODE_PATH,
      CARGO_HOME: process.env.CARGO_HOME,
      RUSTUP_HOME: process.env.RUSTUP_HOME,
      GOPATH: process.env.GOPATH,
      GOROOT: process.env.GOROOT,
      // Allow caller to extend with additional vars
      ...opts.env,
    };
    // Strip undefined values (env keys with undefined values cause spawn errors)
    for (const k of Object.keys(minimalEnv)) {
      if (minimalEnv[k] === undefined) delete minimalEnv[k];
    }
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: minimalEnv,
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

/**
 * Wraps a long-running async operation with periodic progress heartbeat
 * notifications so MCP clients don't time out waiting for a response.
 *
 * Sends a progress ping every `intervalMs` (default 5s) until the operation
 * resolves. Progress value increments from 1 toward 99 (never reaches 100 —
 * the caller is responsible for sending the final progress(100) on success).
 *
 * Safe to call with `progress = undefined` — no-ops cleanly.
 */
export async function withHeartbeat<T>(
  fn: () => Promise<T>,
  progress:
    | ((value: number, total: number, message?: string) => void)
    | undefined,
  opts: { intervalMs?: number; message?: string } = {},
): Promise<T> {
  if (!progress) return fn();
  const intervalMs = opts.intervalMs ?? 5_000;
  let tick = 1;
  const timer = setInterval(() => {
    // Increment slowly toward 99 — never falsely claim 100% complete
    const value = Math.min(tick++, 99);
    progress(value, 100, opts.message ?? "running…");
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
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
