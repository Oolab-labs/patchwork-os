import path from "node:path";

/**
 * One frame pulled out of a stack trace. `file` is raw from the trace —
 * may be absolute, workspace-relative, or a webpack/source-map ref.
 * Resolution to an absolute workspace path is the caller's job.
 */
export interface StackFrame {
  /** Original frame text (trimmed). */
  raw: string;
  /** Function / method / symbol name if identifiable, else null. */
  function: string | null;
  /** File path as it appeared in the trace. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** 1-indexed column, if present. */
  column: number | null;
  /** Detected language family that produced the frame. */
  language: "node" | "python" | "browser" | "generic";
}

/**
 * Heuristic stack-trace parser. Recognises:
 *   Node/V8: `    at fn (/abs/path/file.ts:123:45)`
 *            `    at /abs/path/file.ts:123:45`
 *   Browser: `fn@http://host/path/file.js:123:45`
 *            `http://host/path/file.js:123:45`
 *   Python:  `  File "/path/file.py", line 123, in fn`
 *   Generic: any `file:line:column` or `file:line` inside the text.
 *
 * Frames are returned in the order they appear — the first frame is the
 * top of the stack (where the error was thrown / re-raised last).
 */
export function parseStackTrace(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();

  const push = (f: StackFrame) => {
    const key = `${f.file}:${f.line}:${f.column ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    frames.push(f);
  };

  // Iterate line-by-line so we preserve stack order and keep per-frame regexes
  // anchored (no cross-line bleed).
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Node/V8: `at fn (path:L:C)` or `at path:L:C`
    const nodeParen = /^at\s+(.+?)\s+\((.+?):(\d+)(?::(\d+))?\)$/.exec(trimmed);
    if (nodeParen) {
      push({
        raw: trimmed,
        function: nodeParen[1] ?? null,
        file: nodeParen[2] ?? "",
        line: Number.parseInt(nodeParen[3] ?? "0", 10),
        column: nodeParen[4] ? Number.parseInt(nodeParen[4], 10) : null,
        language: "node",
      });
      continue;
    }
    const nodeBare = /^at\s+(.+?):(\d+)(?::(\d+))?$/.exec(trimmed);
    if (nodeBare) {
      push({
        raw: trimmed,
        function: null,
        file: nodeBare[1] ?? "",
        line: Number.parseInt(nodeBare[2] ?? "0", 10),
        column: nodeBare[3] ? Number.parseInt(nodeBare[3], 10) : null,
        language: "node",
      });
      continue;
    }

    // Python: `File "path", line N, in fn`
    const py = /^File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?$/.exec(
      trimmed,
    );
    if (py) {
      push({
        raw: trimmed,
        function: py[3] ?? null,
        file: py[1] ?? "",
        line: Number.parseInt(py[2] ?? "0", 10),
        column: null,
        language: "python",
      });
      continue;
    }

    // Browser: `fn@url:L:C` (Firefox/Safari format)
    const browserAt = /^(.+?)@(.+?):(\d+)(?::(\d+))?$/.exec(trimmed);
    if (browserAt && !browserAt[2]?.includes(" ")) {
      push({
        raw: trimmed,
        function: browserAt[1] ?? null,
        file: browserAt[2] ?? "",
        line: Number.parseInt(browserAt[3] ?? "0", 10),
        column: browserAt[4] ? Number.parseInt(browserAt[4], 10) : null,
        language: "browser",
      });
      continue;
    }

    // Generic fallback: first `file:line:col` or `file:line` in the text.
    const generic = /([^\s:()]+):(\d+)(?::(\d+))?/.exec(trimmed);
    if (generic) {
      const file = generic[1] ?? "";
      // Skip bare numbers, URLs without paths, and obviously-non-code (e.g. timestamps).
      if (file.length < 2 || /^\d+$/.test(file)) continue;
      push({
        raw: trimmed,
        function: null,
        file,
        line: Number.parseInt(generic[2] ?? "0", 10),
        column: generic[3] ? Number.parseInt(generic[3], 10) : null,
        language: "generic",
      });
    }
  }

  return frames;
}

/**
 * Resolve a parsed frame's `file` to an absolute path inside `workspace`.
 * Handles:
 *   - absolute paths inside the workspace → pass through
 *   - workspace-relative paths → joined with workspace
 *   - URL-form paths (http://host/a/b/file.ts) → strip scheme+host, try as relative
 *
 * Returns `null` for paths that resolve outside the workspace (security
 * guard — we don't want to blame files outside the project root).
 */
export function resolveFrameFile(
  workspace: string,
  file: string,
): string | null {
  if (!file) return null;

  // Strip URL scheme + host → treat as workspace-relative path (leading `/`
  // from the URL path is stripped so it doesn't become root-absolute).
  let candidate = file;
  let wasUrl = false;
  const urlMatch = /^[a-z]+:\/\/[^/]+\/(.*)$/i.exec(candidate);
  if (urlMatch?.[1] !== undefined) {
    candidate = urlMatch[1];
    wasUrl = true;
  }

  // Strip webpack-style prefixes: "webpack://app/./src/..." → "src/..."
  const webpack = /^webpack:\/\/[^/]*\/\.?\/?(.+)$/.exec(candidate);
  if (webpack?.[1]) {
    candidate = webpack[1];
    wasUrl = true;
  }

  const absolute =
    !wasUrl && path.isAbsolute(candidate)
      ? candidate
      : path.resolve(workspace, candidate);
  const normalizedWorkspace = path.resolve(workspace) + path.sep;
  const normalized = path.resolve(absolute);

  if (
    normalized !== path.resolve(workspace) &&
    !normalized.startsWith(normalizedWorkspace)
  ) {
    return null;
  }
  return normalized;
}
