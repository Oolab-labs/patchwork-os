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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
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
        // Prevent path traversal — filename must not contain directory separators
        if (filename.includes("/") || filename.includes("\\")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid filename" }));
          return;
        }
        const filePath = path.join(
          os.homedir(),
          ".patchwork",
          "inbox",
          filename,
        );
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
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    })();
    return true;
  }

  return false;
}
