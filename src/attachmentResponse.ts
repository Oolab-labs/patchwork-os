/**
 * The one way the bridge hands a stored file back over HTTP: as a download.
 *
 * Shared by the inbox attachment route and the uploads route. Every header is
 * a refusal to render: `Content-Disposition: attachment` (save, never display),
 * `nosniff` (the declared type is final), a sandboxed script-free CSP (if a
 * browser renders it anyway, nothing runs) and `no-store`. The file name is
 * interpolated into the header, so callers pass only names that already passed
 * their own plain-name check — no quotes, separators or control characters.
 */

import type { ServerResponse } from "node:http";

export const ATTACHMENT_CSP = "sandbox; default-src 'none'";

export function sendAttachment(
  res: ServerResponse,
  opts: { name: string; bytes: Buffer; contentType: string },
): void {
  res.writeHead(200, {
    "Content-Type": opts.contentType,
    "Content-Disposition": `attachment; filename="${opts.name}"`,
    "Content-Length": String(opts.bytes.length),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": ATTACHMENT_CSP,
    "Cache-Control": "no-store",
  });
  res.end(opts.bytes);
}
