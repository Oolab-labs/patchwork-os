/**
 * Inbox attachments: non-markdown files a recipe (or an export) leaves in the
 * inbox are listed and downloadable byte for byte. Only regular files with a
 * plain name are served — never a symlink, which could otherwise point the
 * download at any file the runtime can read.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryHandleInboxRoute } from "../inboxRoutes.js";

let home = "";
let inbox = "";
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "inbox-attach-"));
  prev = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = path.join(home, ".patchwork");
  inbox = path.join(home, ".patchwork", "inbox");
  mkdirSync(inbox, { recursive: true });
});

afterEach(() => {
  if (prev === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

type Out = { status: number; headers: Record<string, string>; body: Buffer };

function call(
  method: string,
  url: string,
): Promise<{ handled: boolean; out: Out }> {
  return new Promise((resolve) => {
    const out: Out = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const res = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        out.status = status;
        out.headers = headers ?? {};
      },
      end: (chunk?: string | Buffer) => {
        if (chunk)
          out.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        resolve({ handled: true, out });
      },
    } as unknown as ServerResponse;
    const handled = tryHandleInboxRoute(
      { method } as IncomingMessage,
      res,
      new URL(url, "http://127.0.0.1"),
    );
    if (!handled) resolve({ handled, out });
  });
}

describe("GET /inbox lists attachments", () => {
  it("lists regular non-markdown files only", async () => {
    writeFileSync(path.join(inbox, "note.md"), "# hi\nbody");
    writeFileSync(path.join(inbox, "report.csv"), "a,b\n1,2\n");
    writeFileSync(
      path.join(inbox, "workspace-export-20261011-120000.tar.gz"),
      Buffer.from([0x1f, 0x8b, 0, 1]),
    );
    writeFileSync(path.join(inbox, "half.tar.gz.partial"), "x");
    writeFileSync(path.join(inbox, ".hidden"), "x");
    mkdirSync(path.join(inbox, "adir"));
    symlinkSync(path.join(home, "secret.txt"), path.join(inbox, "link.txt"));
    writeFileSync(path.join(home, "secret.txt"), "SECRET");
    const { out } = await call("GET", "/inbox");
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body.toString("utf8"));
    expect(body.items.map((i: { name: string }) => i.name)).toEqual([
      "note.md",
    ]);
    const names = body.attachments.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual([
      "report.csv",
      "workspace-export-20261011-120000.tar.gz",
    ]);
    const exp = body.attachments.find((a: { name: string }) =>
      a.name.endsWith(".tar.gz"),
    );
    expect(exp.size).toBe(4);
    expect(typeof exp.modifiedAt).toBe("string");
  });

  it("an empty or missing inbox reports no attachments", async () => {
    rmSync(inbox, { recursive: true, force: true });
    const { out } = await call("GET", "/inbox");
    expect(JSON.parse(out.body.toString("utf8"))).toEqual({
      items: [],
      attachments: [],
    });
  });
});

describe("GET /inbox/attachments/<name>", () => {
  it("serves the exact bytes as a download", async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x7f, 0x80]);
    writeFileSync(path.join(inbox, "workspace-export-1.tar.gz"), bytes);
    const { out } = await call(
      "GET",
      "/inbox/attachments/workspace-export-1.tar.gz",
    );
    expect(out.status).toBe(200);
    expect(Buffer.compare(out.body, bytes)).toBe(0);
    expect(out.headers["Content-Type"]).toBe("application/gzip");
    expect(out.headers["Content-Disposition"]).toBe(
      'attachment; filename="workspace-export-1.tar.gz"',
    );
    expect(out.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("uses a generic type for unknown extensions", async () => {
    writeFileSync(path.join(inbox, "blob.bin"), "x");
    const { out } = await call("GET", "/inbox/attachments/blob.bin");
    expect(out.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("refuses a symlink, even to a readable file", async () => {
    writeFileSync(path.join(home, "secret.txt"), "SECRET");
    symlinkSync(path.join(home, "secret.txt"), path.join(inbox, "link.txt"));
    const { out } = await call("GET", "/inbox/attachments/link.txt");
    expect(out.status).toBe(404);
    expect(out.body.toString("utf8")).not.toContain("SECRET");
  });

  it("refuses markdown, dotfiles, partial files, directories and traversal", async () => {
    writeFileSync(path.join(inbox, "note.md"), "x");
    writeFileSync(path.join(inbox, ".hidden"), "x");
    writeFileSync(path.join(inbox, "a.tar.gz.partial"), "x");
    mkdirSync(path.join(inbox, "adir"));
    for (const name of [
      "note.md",
      ".hidden",
      "a.tar.gz.partial",
      "adir",
      "..%2Fsecret.txt",
      "%2E%2E",
      "a%5Cb",
    ]) {
      // A dot-segment the URL parser resolves away never reaches this route
      // at all (not handled ⇒ the server's own 404) — also a refusal.
      const { handled, out } = await call("GET", `/inbox/attachments/${name}`);
      if (handled) expect([400, 404], name).toContain(out.status);
      expect(out.body.toString("utf8"), name).not.toContain("SECRET");
    }
  });

  it("answers 404 for a missing file", async () => {
    const { out } = await call("GET", "/inbox/attachments/nothing.zip");
    expect(out.status).toBe(404);
  });
});
