import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { AbsPath } from "../fp/brandedTypes.js";
import { ensureCmdShimIfKnown } from "../winShim.js";

const execFileAsync = promisify(execFile);

/**
 * Detect regex patterns with nested quantifiers that can trigger catastrophic
 * backtracking (ReDoS) — e.g. `(a+)+`, `(ab*)*`, `(a{1,3})+`, `a++`, `a{2,4}+`.
 *
 * Shared guard used by `searchAndReplace` and `applySearchReplace`
 * (previewEdit / stageEdit / transaction commit). Callers should reject the
 * pattern before passing it to `new RegExp(...)` + `String.prototype.replace`,
 * which would otherwise run unbounded on the full file content.
 *
 * This is a heuristic (string-level, not a full regex parser). It is
 * deliberately conservative: it flags the common nesting shapes and may reject
 * a small number of safe-but-unusual patterns. Literal (non-regex) searches
 * must NOT be passed here.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  return (
    /\([^)]*[+*]\)[+*?]/.test(pattern) ||
    /\([^)]*\{[^}]+\}\)[+*{?]/.test(pattern) ||
    /[+*][+*]|\{[^}]+\}[+*]/.test(pattern)
  );
}

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

// Short-TTL cache for workspace root realpaths (30 s). The workspace root is
// stable within a bridge session; resolving it on every resolveFilePath call
// (145 sites) triggers GetFinalPathNameByHandle + Defender scans on Windows.
// 30 s TTL limits the TOCTOU window for a symlink-swap attack to 30 s — an
// attacker with fs write access at that level can already write files directly.
const _realpathCache = new Map<string, { resolved: string; expires: number }>();
const _REALPATH_TTL_MS = 30_000;
function cachedRealpathSync(p: string): string {
  const now = Date.now();
  const cached = _realpathCache.get(p);
  if (cached && now < cached.expires) return cached.resolved;
  const resolved = fs.realpathSync(p);
  _realpathCache.set(p, { resolved, expires: now + _REALPATH_TTL_MS });
  return resolved;
}

export function resolveFilePath(
  filePath: string,
  workspace: string,
  opts: { write?: boolean } = {},
): AbsPath {
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
  // Windows: NTFS is case-insensitive; `C:\foo` and `c:\foo` reach the same
  // inode. `path.resolve` does not normalize drive-letter case, so a strict
  // `startsWith` rejects legitimate-but-mixed-case workspaces. Lowercase
  // both sides before comparison on win32.
  const cmpA = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const cmpB =
    process.platform === "win32"
      ? normalizedWorkspace.toLowerCase()
      : normalizedWorkspace;
  if (cmpA !== cmpB && !cmpA.startsWith(cmpB + path.sep)) {
    const err = new Error(
      `Path "${filePath}" (resolved: "${resolved}") escapes workspace "${workspace}". All paths must be within the workspace. For files outside the workspace (e.g. ~/.claude/), use the native Read tool instead.`,
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

  return resolved as AbsPath;
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
  isError?: undefined;
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
  isError?: undefined;
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

/**
 * Build a tool-error result (ADR-0004 Tier 2).
 *
 * The `text` content block carries the plain, human/LLM-readable error
 * message — never a JSON blob. An LLM consuming a failed tool call should be
 * able to read the message directly without JSON-parsing it.
 *
 * Machine-readable fields (`code` and any extra fields passed via the object
 * form) are surfaced in `structuredContent` for non-LLM clients that want a
 * stable, parseable shape. `structuredContent.error` always holds the same
 * message string as the text block.
 *
 * Accepts either a plain message string or an object. For the object form the
 * human-readable message is taken from `error` / `message`, falling back to a
 * JSON rendering only when neither is present.
 */
export function error(
  data: string | Record<string, unknown>,
  code?: string,
): {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  let message: string;
  let structured: Record<string, unknown>;
  if (typeof data === "string") {
    message = data;
    structured = { error: data };
  } else {
    structured = { ...data };
    const m = data.error ?? data.message;
    message = typeof m === "string" ? m : JSON.stringify(data);
    structured.error = message;
  }
  if (code !== undefined) structured.code = code;
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    isError: true,
  };
}

export function extensionRequired(feature: string, alternatives?: string[]) {
  let msg = `VS Code extension not connected — ${feature} requires the extension.\n\nTo reconnect: open the Command Palette → "Claude IDE Bridge: Reconnect"`;
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
  return pathToFileURL(absPath).href;
}

/**
 * Sanitize an untrusted commit subject (or similar single-line text from a
 * repository) before it is placed into LLM-visible tool output.
 *
 * Strips ASCII control characters (except none — tab/newline have no place in a
 * single-line subject), the DEL char, and Unicode bidirectional-override /
 * directional-isolate codepoints that can be used to visually reorder injected
 * text. Caps length at 500 chars. Mirrors the prompt-injection hardening
 * applied to LSP diagnostic messages in getDiagnostics.ts (sanitizeMessage).
 */
const MAX_COMMIT_SUBJECT_LEN = 500;
// Control chars + DEL, plus Unicode text-reordering codepoints:
//   U+202A–U+202E  bidi embeddings/overrides
//   U+2066–U+2069  bidi isolates
//   U+200E/U+200F  LRM/RLM
//   U+061C         Arabic letter mark
// All can be abused to visually reorder injected instructions. \u escapes keep
// the source ASCII-only (matches the sanitizeMessage style in getDiagnostics.ts).
const COMMIT_SUBJECT_STRIP_RE =
  /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
export function sanitizeCommitSubject(subject: unknown): string {
  const s = typeof subject === "string" ? subject : String(subject ?? "");
  return s
    .replace(COMMIT_SUBJECT_STRIP_RE, " ")
    .slice(0, MAX_COMMIT_SUBJECT_LEN);
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

/**
 * Sink-side allowlist for execSafe / execSafeStreaming. The bridge resolves
 * `cmd` against $PATH, so a shared environment can in principle substitute a
 * binary; checking the basename here gates that surface to a vetted set even
 * if a caller passes user-derived input by mistake. Callers that route
 * through their own allowlist (runCommand, terminal fallback) opt in via
 * `opts.allowlistChecked: true` and bypass this check.
 *
 * Closes CodeQL js/shell-command-injection-from-environment by attaching the
 * sanitization to the sink itself (per the lesson in
 * feedback_redos_bound_doesnt_help.md: structural fix at the sink, not an
 * upstream guard CodeQL's taint-flow can't see).
 */
const SAFE_BIN_BASENAMES = new Set([
  // VCS + GitHub CLI
  "git",
  "gh",
  // Search / find
  "grep",
  "rg",
  "fd",
  "find",
  // Package managers
  "npm",
  "yarn",
  "pnpm",
  "cargo",
  "go",
  "pip",
  // Typecheckers (interpreters like `node`, `python`, `bash` deliberately
  // excluded — even with allowlisted argv, an interpreter accepts arbitrary
  // code via -e/-c. Callers with a known-safe argv shape opt in via
  // `opts.allowlistChecked: true`.)
  "tsc",
  "pyright",
  // Headless symbol-search fallback (searchWorkspaceSymbols) — Universal Ctags.
  "ctags",
  // Test runners — fixed argv shape, not general interpreters
  "vitest",
  "jest",
  // Linters / formatters / fixers
  "eslint",
  "biome",
  "prettier",
  "ruff",
  "black",
  // Repo scanning
  "ts-prune",
  // Browsers / file openers (cmd.exe is excluded for the same reason as
  // interpreters — Windows browser-launch in openInBrowser uses
  // allowlistChecked:true with a fixed argv shape.)
  "open",
  "xdg-open",
  // npx is allowlisted because detectUnusedCode invokes `npx tsc` as a
  // fallback when local tsc isn't on PATH. The argv shape is fixed (npx
  // <tool> [args]) and the tool name is hardcoded by the caller; this
  // is not a general "let users run any package" escape hatch.
  "npx",
  // Windows shim equivalents — Node's `path.basename` returns the .cmd/.bat
  // suffix on win32 when the caller passes the full shim path.
  "git.exe",
  "gh.exe",
  "rg.exe",
  "ctags.exe",
  "npm.cmd",
  "npx.cmd",
  "yarn.cmd",
  "pnpm.cmd",
  "tsc.cmd",
  "eslint.cmd",
  "biome.cmd",
  "prettier.cmd",
]);

function assertSafeBinary(cmd: string): void {
  // path.basename strips directory components (incl. node_modules/.bin/foo
  // forms used for workspace-local binaries). The check is on the resolved
  // basename so an absolute path like /usr/local/bin/git is treated as "git".
  const basename = path.basename(cmd);
  if (!SAFE_BIN_BASENAMES.has(basename)) {
    throw new Error(
      `execSafe: command "${cmd}" is not in the safe-binary set. Callers that gate on their own allowlist (e.g. runCommand) must pass opts.allowlistChecked=true.`,
    );
  }
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
    /** Caller has gated `cmd` against its own allowlist (e.g. config.commandAllowlist). Skips the SAFE_BIN_BASENAMES check. */
    allowlistChecked?: boolean;
  } = {},
): Promise<ExecSafeResult> {
  if (!opts.allowlistChecked) assertSafeBinary(cmd);
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
      // Windows-essential env vars (audit 2026-05-17). Without these,
      // git can't find ~/.gitconfig (uses %USERPROFILE%), gh can't find
      // its config (uses %APPDATA%), executables can't be resolved
      // without %PATHEXT%, and many `.exe` invocations fail without
      // %SYSTEMROOT% for DLL search. No-op on POSIX (all undefined).
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      USERNAME: process.env.USERNAME,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PATHEXT: process.env.PATHEXT,
      COMSPEC: process.env.COMSPEC,
      WINDIR: process.env.WINDIR,
      // Allow caller to extend with additional vars
      ...opts.env,
    };
    // Strip undefined values (env keys with undefined values cause spawn errors)
    for (const k of Object.keys(minimalEnv)) {
      if (minimalEnv[k] === undefined) delete minimalEnv[k];
    }
    // On Windows, bare binary names like "npm" / "tsc" need `.cmd` resolution
    // because shell:false won't consult PATHEXT for non-.exe shims. Use the
    // conservative variant so we ONLY wrap known npm shims — system binaries
    // like `git` (resolved as git.exe via PATHEXT) and shell built-ins must
    // be left alone, or `spawn("git.cmd")` ENOENTs on Windows.
    const spawnCmd = ensureCmdShimIfKnown(cmd);
    const { stdout, stderr } = await execFileAsync(spawnCmd, args, {
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
/**
 * Streaming variant of execSafe — calls `onLine` for each complete stdout line and
 * `onStderrLine` for each complete stderr line as the process runs, while still
 * collecting both streams for the final result.
 * Falls back to regular execSafe behavior when neither callback is provided.
 */
export async function execSafeStreaming(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    /** Caller has gated `cmd` against its own allowlist. Skips the SAFE_BIN_BASENAMES check. */
    allowlistChecked?: boolean;
  } = {},
): Promise<ExecSafeResult> {
  if (!opts.allowlistChecked) assertSafeBinary(cmd);
  const { onLine, onStderrLine, ...restOpts } = opts;
  if (!onLine && !onStderrLine) return execSafe(cmd, args, restOpts);

  const timeout = opts.timeout ?? 30_000;
  const maxBuffer = opts.maxBuffer ?? 512 * 1024;
  const start = Date.now();

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
    NVM_DIR: process.env.NVM_DIR,
    NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX,
    NODE_PATH: process.env.NODE_PATH,
    CARGO_HOME: process.env.CARGO_HOME,
    RUSTUP_HOME: process.env.RUSTUP_HOME,
    GOPATH: process.env.GOPATH,
    GOROOT: process.env.GOROOT,
    // Windows-essential env (audit 2026-05-17 — see execSafe above)
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERNAME: process.env.USERNAME,
    SYSTEMROOT: process.env.SYSTEMROOT,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
    WINDIR: process.env.WINDIR,
    ...opts.env,
  };
  for (const k of Object.keys(minimalEnv)) {
    if (minimalEnv[k] === undefined) delete minimalEnv[k];
  }

  return new Promise<ExecSafeResult>((resolve) => {
    // ensureCmdShimIfKnown handles Windows .cmd resolution; see note in execSafe above.
    const spawnCmd = ensureCmdShimIfKnown(cmd);
    const proc = spawn(spawnCmd, args, {
      cwd: opts.cwd,
      env: minimalEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutFull = ""; // full collected stdout for result
    let linePartial = ""; // incomplete line being buffered
    let stderrBuf = "";
    let stdoutBytes = 0;
    // Audit 2026-06-08 (tools-1): track stderr in BYTES like stdout. The old
    // `stderrBuf.length + chunk.length` mixed string char-count (UTF-16 units)
    // with Buffer byte-count, so multi-byte stderr overran maxBuffer.
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    const abortHandler = () => {
      clearTimeout(timer);
      proc.kill();
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => {
      // Track raw bytes (not re-encoded string) for accurate maxBuffer comparison
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) {
        const text = chunk.toString("utf-8");
        stdoutFull += text;
        linePartial += text;
        // Split on newlines and call onLine for each complete line
        const lines = linePartial.split("\n");
        // Last element may be incomplete — keep it in buffer
        linePartial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) onLine?.(line);
        }
      } else {
        // Overflow: discard further line buffering to avoid flushing a stale
        // partial line as a complete line on close
        linePartial = "";
      }
    });

    let stderrPartial = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) {
        const text = chunk.toString("utf-8");
        stderrBuf += text;
        if (onStderrLine) {
          stderrPartial += text;
          const lines = stderrPartial.split("\n");
          stderrPartial = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length > 0) onStderrLine(line);
          }
        }
      } else {
        // Overflow: discard the buffered partial so a truncated fragment from
        // before the overflow is not flushed as a complete line on close.
        // Mirrors the stdout `linePartial = ""` clear above (tools-core-2).
        stderrPartial = "";
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      // Flush any remaining partial lines (only non-empty, non-overflow)
      if (linePartial.length > 0) onLine?.(linePartial);
      if (stderrPartial.length > 0) onStderrLine?.(stderrPartial);
      resolve({
        stdout: stdoutFull,
        stderr: stderrBuf,
        exitCode: code ?? 1,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
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
  // Normalise separators so that Unix-style paths returned by fd/find/git on
  // Windows still match a workspace that was resolved with backslashes (and
  // vice-versa). Accept either "/" or "\" as the trailing separator.
  const norm = absPath.replace(/\\/g, "/");
  const ws = workspace.replace(/\\/g, "/");
  return norm.startsWith(`${ws}/`) ? norm.slice(ws.length + 1) : norm;
}
