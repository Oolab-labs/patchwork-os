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
            const stripped = content
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
        res.end(
          JSON.stringify({
            name: filename,
            content,
            modifiedAt: stats.mtime.toISOString(),
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
