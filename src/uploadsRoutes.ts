/**
 * Workspace upload routes. Mounted after the Bearer gate in server.ts, like
 * `tryHandleInboxRoute`; the storage rules live in `src/uploadStore.ts`.
 *
 *   POST   /uploads         raw body; name in `X-Upload-Filename`
 *                           (percent-encoded UTF-8). 201 → `{ ok, upload,
 *                           renamedFrom? }`. The stored name may differ: a
 *                           collision gets `-1`, `-2`…, and characters outside
 *                           the name set become `_`.
 *   GET    /uploads         `{ uploads: [{ name, size, sha256, contentType,
 *                           uploadedAt }] }`, newest first.
 *   GET    /uploads/:name   the bytes, always as an attachment with a generic
 *                           `application/octet-stream` type — never rendered.
 *   DELETE /uploads/:name   `{ ok: true }`.
 *
 * Errors are `{ ok: false, error, code }` with the status from the store
 * (400 name, 413 size/quota, 415 type/content, 404 missing).
 *
 * The request's own `Content-Type` is not trusted for anything: the type is
 * decided by the name's extension and checked against the bytes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendAttachment } from "./attachmentResponse.js";
import { respond500 } from "./httpErrorResponse.js";
import { readBodyWithCap } from "./recipeRoutes.js";
import {
  deleteUpload,
  listUploads,
  readUpload,
  saveUpload,
  UPLOAD_MAX_FILE_BYTES,
  type UploadFailure,
} from "./uploadStore.js";

/** Header carrying the client's file name (percent-encoded UTF-8). */
export const UPLOAD_FILENAME_HEADER = "x-upload-filename";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendFailure(res: ServerResponse, f: UploadFailure): void {
  sendJson(res, f.status, { ok: false, error: f.error, code: f.code });
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function tryHandleUploadsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
): boolean {
  const pathname = parsedUrl.pathname;

  if (pathname === "/uploads" && req.method === "GET") {
    void (async () => {
      try {
        sendJson(res, 200, { uploads: await listUploads() });
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  if (pathname === "/uploads" && req.method === "POST") {
    void (async () => {
      try {
        const header = req.headers?.[UPLOAD_FILENAME_HEADER];
        const rawHeader = Array.isArray(header) ? header[0] : header;
        // Read (and drain) the body before answering anything, so a refused
        // upload still gets a clean response rather than a reset socket.
        const read = await readBodyWithCap(req, UPLOAD_MAX_FILE_BYTES);
        if (!read.ok) {
          sendJson(res, 413, {
            ok: false,
            error: `The file is larger than the ${UPLOAD_MAX_FILE_BYTES}-byte limit`,
            code: "upload_too_large",
          });
          return;
        }
        if (typeof rawHeader !== "string" || rawHeader.length === 0) {
          sendJson(res, 400, {
            ok: false,
            error: `A file name is required in the ${UPLOAD_FILENAME_HEADER} header`,
            code: "upload_name_missing",
          });
          return;
        }
        const name = decodeSegment(rawHeader);
        if (name === null) {
          sendJson(res, 400, {
            ok: false,
            error: "The file name is not valid percent-encoded UTF-8",
            code: "upload_name_invalid",
          });
          return;
        }
        const saved = await saveUpload(name, read.bytes);
        if (!saved.ok) {
          sendFailure(res, saved);
          return;
        }
        sendJson(res, 201, saved);
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  const match = pathname?.match(/^\/uploads\/([^/]+)$/);
  if (match && (req.method === "GET" || req.method === "DELETE")) {
    const name = decodeSegment(match[1] ?? "") ?? "";
    void (async () => {
      try {
        if (req.method === "DELETE") {
          const r = await deleteUpload(name);
          if (!r.ok) sendFailure(res, r);
          else sendJson(res, 200, { ok: true });
          return;
        }
        const r = await readUpload(name);
        if (!r.ok) {
          sendFailure(res, r);
          return;
        }
        // A generic type, whatever the file is: a download is never rendered,
        // and the dashboard proxy streams this type through byte for byte.
        sendAttachment(res, {
          name: r.entry.name,
          bytes: r.bytes,
          contentType: "application/octet-stream",
        });
      } catch (err) {
        respond500(res, err);
      }
    })();
    return true;
  }

  return false;
}
