/**
 * Inbox route dispatcher — extracted from src/server.ts.
 *
 * Owns `/inbox` (list markdown files in ~/.patchwork/inbox) and
 * `/inbox/<filename>.md` (read a single inbox file). Server.ts delegates
 * with a single `tryHandleInboxRoute` call.
 *
 * Mechanical lift — handler bodies are byte-identical to the original
 * block. Pre-extraction grep confirmed zero `this.` references; no
 * dependency injection was needed.
 *
 * Security note: the by-filename route MUST reject paths containing `/`
 * or `\\` to prevent traversal out of the inbox directory. The check is
 * preserved verbatim from the original.
 */

import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { respond500 } from "./httpErrorResponse.js";

/**
 * Phase 0β provenance shape. Optional + additive — files without
 * frontmatter return `provenance: undefined`.
 */
export interface InboxProvenance {
  recipe?: string;
  runSeq?: number;
  trigger?: string;
  deliveredAt?: string;
}

/**
 * Split a markdown file into its YAML-frontmatter block (parsed as a flat
 * `key: value` map) and the remaining body. Frontmatter is recognised
 * only when the file begins with `---\n` and a closing `---` line is
 * found within the first 30 lines (cap to bound the scan). Returns
 * `{ provenance: undefined, body: content }` for files without
 * frontmatter so callers degrade gracefully on legacy inbox items.
 */
export function parseInboxFile(content: string): {
  provenance: InboxProvenance | undefined;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { provenance: undefined, body: content };
  }
  const lines = content.split("\n");
  // lines[0] === "---". Find the next "---" delimiter.
  let endIdx = -1;
  const maxScan = Math.min(lines.length, 30);
  for (let i = 1; i < maxScan; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    // Malformed — no closing delimiter. Treat as body-only.
    return { provenance: undefined, body: content };
  }
  const fm: InboxProvenance = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i] ?? "";
    const m = /^([a-zA-Z][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rawVal = (m[2] ?? "").trim();
    if (key === "runSeq") {
      const n = Number.parseInt(rawVal, 10);
      if (Number.isFinite(n)) fm.runSeq = n;
    } else if (key === "recipe" || key === "trigger" || key === "deliveredAt") {
      (fm as Record<string, string>)[key] = rawVal;
    }
  }
  const body = lines.slice(endIdx + 1).join("\n");
  // Strip a single leading blank line if present (frontmatter writers
  // emit a trailing blank line by convention).
  const trimmedBody = body.startsWith("\n") ? body.slice(1) : body;
  return { provenance: fm, body: trimmedBody };
}

/**
 * Filename guard shared by every inbox sub-route. Rejects directory
 * separators and `..` segments so the request can never escape the inbox
 * directory. Returns the joined absolute path on success, or null with the
 * caller responsible for emitting a 400.
 */
function safeInboxPath(filename: string): string | null {
  if (!filename) return null;
  if (filename.includes("/") || filename.includes("\\")) return null;
  if (filename === "." || filename === "..") return null;
  if (filename.startsWith(".")) return null; // no dotfiles, reserves `.archive/` namespace
  return path.join(os.homedir(), ".patchwork", "inbox", filename);
}

/**
 * Try to handle an `/inbox` or `/inbox/<filename>.md` route. Returns true
 * if the route was dispatched (caller should `return` from the request
 * handler), false if no route matched.
 */
export function tryHandleInboxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
): boolean {
  if (parsedUrl.pathname === "/inbox" && req.method === "GET") {
    void (async () => {
      try {
        const { readdir, readFile, stat } = await import("node:fs/promises");
        const inboxDir = path.join(os.homedir(), ".patchwork", "inbox");
        if (!existsSync(inboxDir)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ items: [] }));
          return;
        }
        const files = (await readdir(inboxDir)).filter((f) =>
          f.endsWith(".md"),
        );
        const items = await Promise.all(
          files.map(async (name) => {
            const filePath = path.join(inboxDir, name);
            const [content, stats] = await Promise.all([
              readFile(filePath, "utf8"),
              stat(filePath),
            ]);
            // Phase 0β — consume frontmatter FIRST, then strip
            // heading-`#` lines from the body only. Previously the
            // `#`-strip ran over the whole file, which meant any
            // pre-existing `#`-prefixed body line was eaten AND, more
            // subtly, frontmatter values (lines like `recipe: x`,
            // `---`) leaked into the preview because they weren't
            // `#`-prefixed. Splitting the two passes fixes both.
            const { provenance, body } = parseInboxFile(content);
            const stripped = body
              .split("\n")
              .filter((l) => !l.startsWith("#"))
              .join("\n")
              .trim();
            // `path` intentionally omitted — leaking the absolute filesystem
            // path (which includes the user's home dir / username) is a
            // low-impact info-disclosure if the dashboard is ever proxied to
            // an untrusted client (shared screen, screenshots, browser
            // extensions reading the DOM). Callers identify items by `name`,
            // and the read endpoint joins it back to inboxDir on the server.
            return {
              name,
              modifiedAt: stats.mtime.toISOString(),
              preview: stripped.slice(0, 200),
              ...(provenance && { provenance }),
            };
          }),
        );
        items.sort(
          (a, b) =>
            new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items }));
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  const inboxFileMatch = parsedUrl.pathname?.match(/^\/inbox\/([^/]+\.md)$/);
  if (inboxFileMatch && req.method === "GET") {
    void (async () => {
      try {
        const { readFile, stat } = await import("node:fs/promises");
        const filename = decodeURIComponent(inboxFileMatch[1] ?? "");
        const filePath = safeInboxPath(filename);
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid filename" }));
          return;
        }
        const [content, stats] = await Promise.all([
          readFile(filePath, "utf8"),
          stat(filePath),
        ]);
        res.writeHead(200, { "Content-Type": "application/json" });
        const { provenance } = parseInboxFile(content);
        res.end(
          JSON.stringify({
            name: filename,
            content,
            modifiedAt: stats.mtime.toISOString(),
            ...(provenance && { provenance }),
          }),
        );
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        } else {
          respond500(res, err);
        }
      }
    })();
    return true;
  }

  if (inboxFileMatch && req.method === "DELETE") {
    void (async () => {
      try {
        const { unlink } = await import("node:fs/promises");
        const filename = decodeURIComponent(inboxFileMatch[1] ?? "");
        const filePath = safeInboxPath(filename);
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid filename" }));
          return;
        }
        await unlink(filePath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: filePath }));
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not found" }));
        } else {
          respond500(res, err);
        }
      }
    })();
    return true;
  }

  // POST /inbox/<filename>.md/archive — move to ~/.patchwork/inbox/.archive/
  const inboxArchiveMatch = parsedUrl.pathname?.match(
    /^\/inbox\/([^/]+\.md)\/archive$/,
  );
  if (inboxArchiveMatch && req.method === "POST") {
    void (async () => {
      try {
        const { mkdir, rename } = await import("node:fs/promises");
        const filename = decodeURIComponent(inboxArchiveMatch[1] ?? "");
        const filePath = safeInboxPath(filename);
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid filename" }));
          return;
        }
        const archiveDir = path.join(
          os.homedir(),
          ".patchwork",
          "inbox",
          ".archive",
        );
        await mkdir(archiveDir, { recursive: true });
        let dest = path.join(archiveDir, filename);
        // Suffix with timestamp on collision so historical archives survive.
        if (existsSync(dest)) {
          const ext = path.extname(filename);
          const stem = filename.slice(0, filename.length - ext.length);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          dest = path.join(archiveDir, `${stem}.${stamp}${ext}`);
        }
        await rename(filePath, dest);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: dest }));
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not found" }));
        } else {
          respond500(res, err);
        }
      }
    })();
    return true;
  }

  return false;
}
