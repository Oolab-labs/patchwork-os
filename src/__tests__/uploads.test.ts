/**
 * Workspace uploads: a document a user hands the runtime so a recipe can work
 * over it (`POST /uploads`, `type: file` recipe inputs).
 *
 * The store is a plain directory under the Patchwork home, and every rule here
 * exists because the name and the bytes come from the network:
 *   - a stored name is a plain file name — no separators, no `..`, no dotfile,
 *     no control character — and is never followed through a symlink;
 *   - per-file and per-workspace size caps refuse rather than truncate;
 *   - only a short list of document/image types is accepted, by extension AND
 *     by content, so an `.html`, an `.svg` or a `.pdf` that is not a PDF is
 *     refused;
 *   - a name collision gets a numeric suffix, never an overwrite;
 *   - a download is always an attachment, never rendered inline.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteUpload,
  listUploads,
  resolveUploadPath,
  sanitizeUploadName,
  saveUpload,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_TOTAL_BYTES,
  uploadNameError,
  uploadsDir,
} from "../uploadStore.js";
import { tryHandleUploadsRoute } from "../uploadsRoutes.js";

const POSIX = process.platform !== "win32";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]);

let home = "";
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "uploads-"));
  prev = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = path.join(home, ".patchwork");
});

afterEach(() => {
  if (prev === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("limits", () => {
  it("10 MB per file, 200 MB per workspace", () => {
    expect(UPLOAD_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(UPLOAD_MAX_TOTAL_BYTES).toBe(200 * 1024 * 1024);
  });
  it("the store lives under the Patchwork home", () => {
    expect(uploadsDir()).toBe(path.join(home, ".patchwork", "uploads"));
  });
});

describe("upload names", () => {
  it.each([
    "../escape.txt",
    "..",
    "a/../../b.txt",
    "dir/notes.txt",
    "dir\\notes.txt",
    "/etc/passwd.txt",
    ".hidden.txt",
    ".env",
    "notes\u0000.txt",
    "notes\n.txt",
    "notes\u007f.txt",
    "",
    "a..b.txt",
  ])("refuses %j", (raw) => {
    const r = sanitizeUploadName(raw);
    expect(r.ok).toBe(false);
  });

  it("keeps an ordinary name as it is", () => {
    expect(sanitizeUploadName("Receipt 2026-10-12.pdf")).toEqual({
      ok: true,
      name: "Receipt 2026-10-12.pdf",
    });
  });

  it("replaces harmless punctuation instead of refusing the upload", () => {
    const r = sanitizeUploadName("receipt (1) #final.pdf");
    expect(r).toEqual({ ok: true, name: "receipt _1_ _final.pdf" });
  });

  it("the strict check accepts only what the sanitiser produces", () => {
    expect(uploadNameError("notes.md")).toBeNull();
    expect(uploadNameError("../notes.md")).not.toBeNull();
    expect(uploadNameError("notes (1).md")).not.toBeNull();
    expect(uploadNameError(".notes.md")).not.toBeNull();
    expect(uploadNameError("notes.exe")).not.toBeNull();
    expect(uploadNameError(42)).not.toBeNull();
  });
});

describe("saveUpload", () => {
  it("writes the bytes 0o600 and reports name, size, sha256 and type", async () => {
    const r = await saveUpload("notes.md", Buffer.from("# hi\n"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upload.name).toBe("notes.md");
    expect(r.upload.size).toBe(5);
    expect(r.upload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.upload.contentType).toBe("text/markdown; charset=utf-8");
    const file = path.join(uploadsDir(), "notes.md");
    expect(readFileSync(file, "utf8")).toBe("# hi\n");
    if (POSIX) expect(statSync(file).mode & 0o777).toBe(0o600);
    // No temp file left behind.
    expect(readdirSync(uploadsDir())).toEqual(["notes.md"]);
  });

  it("a collision gets a numeric suffix, never an overwrite", async () => {
    await saveUpload("notes.txt", Buffer.from("first"));
    const second = await saveUpload("notes.txt", Buffer.from("second"));
    const third = await saveUpload("notes.txt", Buffer.from("third"));
    expect(second.ok && second.upload.name).toBe("notes-1.txt");
    expect(third.ok && third.upload.name).toBe("notes-2.txt");
    expect(readFileSync(path.join(uploadsDir(), "notes.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("refuses a file over the per-file cap", async () => {
    const r = await saveUpload("big.txt", Buffer.alloc(11, 0x61), {
      maxFileBytes: 10,
    });
    expect(r).toMatchObject({
      ok: false,
      status: 413,
      code: "upload_too_large",
    });
    expect(existsSync(path.join(uploadsDir(), "big.txt"))).toBe(false);
  });

  it("refuses an upload that would take the workspace over its total cap", async () => {
    const opts = { maxTotalBytes: 20 };
    expect((await saveUpload("a.txt", Buffer.alloc(15, 0x61), opts)).ok).toBe(
      true,
    );
    const r = await saveUpload("b.txt", Buffer.alloc(6, 0x61), opts);
    expect(r).toMatchObject({
      ok: false,
      status: 413,
      code: "upload_quota_exceeded",
    });
    expect(existsSync(path.join(uploadsDir(), "b.txt"))).toBe(false);
    expect((await saveUpload("c.txt", Buffer.alloc(5, 0x61), opts)).ok).toBe(
      true,
    );
  });

  it("refuses an empty upload", async () => {
    const r = await saveUpload("empty.txt", Buffer.alloc(0));
    expect(r).toMatchObject({ ok: false, code: "upload_empty" });
  });

  it.each([
    ["page.html", "<html><body>hi</body></html>"],
    ["page.htm", "<html></html>"],
    ["image.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["run.sh", "#!/bin/sh\necho hi\n"],
    ["tool.exe", "MZ\u0090\u0000"],
    ["noext", "plain"],
  ])("refuses the type of %s", async (name, body) => {
    const r = await saveUpload(name, Buffer.from(body));
    expect(r).toMatchObject({
      ok: false,
      status: 415,
      code: "upload_type_refused",
    });
    expect(existsSync(path.join(uploadsDir(), name))).toBe(false);
  });

  it.each([
    ["fake.pdf", Buffer.from("<html>not a pdf</html>")],
    ["fake.png", PDF],
    ["fake.jpg", PNG],
    ["fake.webp", Buffer.from("RIFF0000AVI LIST")],
    ["fake.txt", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])],
    ["fake.json", Buffer.from("{not json")],
    ["page.txt", Buffer.from("  <!DOCTYPE html><html></html>")],
    ["pic.md", Buffer.from("<svg onload=alert(1)></svg>")],
    ["bad-utf8.csv", Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a])],
  ])("refuses %s whose content is not what its extension says", async (name, bytes) => {
    const r = await saveUpload(name, bytes);
    expect(r).toMatchObject({
      ok: false,
      status: 415,
      code: "upload_content_mismatch",
    });
  });

  it.each([
    ["receipt.pdf", PDF],
    ["photo.png", PNG],
    ["photo.jpg", JPG],
    ["photo.jpeg", JPG],
    ["photo.webp", WEBP],
    ["data.csv", Buffer.from("a,b\n1,2\n")],
    ["data.json", Buffer.from('{"a":1}')],
    ["notes.txt", Buffer.from("café ✓\n")],
  ])("accepts %s", async (name, bytes) => {
    const r = await saveUpload(name, bytes);
    expect(r.ok).toBe(true);
  });

  it.skipIf(!POSIX)(
    "refuses to write through a symlinked uploads directory",
    async () => {
      const elsewhere = path.join(home, "elsewhere");
      mkdirSync(elsewhere);
      mkdirSync(path.join(home, ".patchwork"), { recursive: true });
      symlinkSync(elsewhere, uploadsDir());
      const r = await saveUpload("notes.txt", Buffer.from("x"));
      expect(r.ok).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([]);
    },
  );

  it.skipIf(!POSIX)(
    "a symlink squatting on the name is never written through",
    async () => {
      mkdirSync(uploadsDir(), { recursive: true });
      const target = path.join(home, "target.txt");
      writeFileSync(target, "ORIGINAL");
      symlinkSync(target, path.join(uploadsDir(), "notes.txt"));
      const r = await saveUpload("notes.txt", Buffer.from("new"));
      expect(r.ok && r.upload.name).toBe("notes-1.txt");
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    },
  );
});

describe("listUploads / deleteUpload / resolveUploadPath", () => {
  it("lists regular uploads only — no dotfiles, temp files, dirs or symlinks", async () => {
    await saveUpload("notes.md", Buffer.from("# a"));
    await saveUpload("receipt.pdf", PDF);
    writeFileSync(path.join(uploadsDir(), ".upload-123.partial"), "x");
    mkdirSync(path.join(uploadsDir(), "adir.txt"));
    if (POSIX) {
      writeFileSync(path.join(home, "secret.txt"), "SECRET");
      symlinkSync(
        path.join(home, "secret.txt"),
        path.join(uploadsDir(), "link.txt"),
      );
    }
    const list = await listUploads();
    expect(list.map((u) => u.name).sort()).toEqual(["notes.md", "receipt.pdf"]);
    const pdf = list.find((u) => u.name === "receipt.pdf");
    expect(pdf).toMatchObject({
      size: PDF.length,
      contentType: "application/pdf",
    });
    expect(pdf?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof pdf?.uploadedAt).toBe("string");
  });

  it("a missing uploads directory lists as empty", async () => {
    expect(await listUploads()).toEqual([]);
  });

  it("deletes an upload, and refuses traversal", async () => {
    await saveUpload("notes.md", Buffer.from("# a"));
    writeFileSync(path.join(home, "keep.md"), "keep");
    expect(await deleteUpload("../../keep.md")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(existsSync(path.join(home, "keep.md"))).toBe(true);
    expect(await deleteUpload("notes.md")).toEqual({ ok: true });
    expect(existsSync(path.join(uploadsDir(), "notes.md"))).toBe(false);
    expect(await deleteUpload("notes.md")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("resolves an existing upload to its absolute path and hash", async () => {
    const saved = await saveUpload("notes.md", Buffer.from("# a"));
    const r = resolveUploadPath("notes.md");
    expect(r).toMatchObject({
      ok: true,
      path: path.join(uploadsDir(), "notes.md"),
      sha256: saved.ok ? saved.upload.sha256 : "",
    });
  });

  it.each([
    "missing.md",
    "../notes.md",
    "../outside.txt",
    "/etc/hosts",
    `${os.tmpdir()}/x.txt`,
  ])("does not resolve %j", async (name) => {
    await saveUpload("notes.md", Buffer.from("# a"));
    // A real file one level up, so a traversal that escaped would FIND it.
    writeFileSync(path.join(home, ".patchwork", "outside.txt"), "OUTSIDE");
    expect(resolveUploadPath(name).ok).toBe(false);
  });

  it.skipIf(!POSIX)(
    "does not resolve a symlink in the uploads dir",
    async () => {
      mkdirSync(uploadsDir(), { recursive: true });
      writeFileSync(path.join(home, "secret.txt"), "SECRET");
      symlinkSync(
        path.join(home, "secret.txt"),
        path.join(uploadsDir(), "s.txt"),
      );
      expect(lstatSync(path.join(uploadsDir(), "s.txt")).isSymbolicLink()).toBe(
        true,
      );
      expect(resolveUploadPath("s.txt").ok).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

type Out = { status: number; headers: Record<string, string>; body: Buffer };

function call(
  method: string,
  url: string,
  opts: { body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ handled: boolean; out: Out }> {
  return new Promise((resolve) => {
    const out: Out = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const res = {
      headersSent: false,
      writableEnded: false,
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
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      method,
      headers: Object.fromEntries(
        Object.entries(opts.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    }) as unknown as IncomingMessage;
    const handled = tryHandleUploadsRoute(
      req,
      res,
      new URL(url, "http://127.0.0.1"),
    );
    if (!handled) resolve({ handled, out });
    stream.end(opts.body ?? Buffer.alloc(0));
  });
}

function json(out: Out): Record<string, unknown> {
  return JSON.parse(out.body.toString("utf8"));
}

describe("POST /uploads", () => {
  it("stores the raw body under the X-Upload-Filename name", async () => {
    const { out } = await call("POST", "/uploads", {
      body: PDF,
      headers: {
        "X-Upload-Filename": encodeURIComponent("Receipt 1.pdf"),
        "Content-Type": "application/pdf",
      },
    });
    expect(out.status).toBe(201);
    const body = json(out) as { ok: boolean; upload: { name: string } };
    expect(body.ok).toBe(true);
    expect(body.upload.name).toBe("Receipt 1.pdf");
    expect(
      Buffer.compare(
        readFileSync(path.join(uploadsDir(), "Receipt 1.pdf")),
        PDF,
      ),
    ).toBe(0);
  });

  it("requires a filename", async () => {
    const { out } = await call("POST", "/uploads", { body: PDF });
    expect(out.status).toBe(400);
    expect(json(out).code).toBe("upload_name_missing");
  });

  it("refuses a traversal name", async () => {
    const { out } = await call("POST", "/uploads", {
      body: Buffer.from("x"),
      headers: { "X-Upload-Filename": encodeURIComponent("../../evil.txt") },
    });
    expect(out.status).toBe(400);
    expect(json(out).code).toBe("upload_name_invalid");
    expect(existsSync(path.join(home, "evil.txt"))).toBe(false);
  });

  it("refuses an html upload with 415", async () => {
    const { out } = await call("POST", "/uploads", {
      body: Buffer.from("<html></html>"),
      headers: { "X-Upload-Filename": "x.html" },
    });
    expect(out.status).toBe(415);
    expect(json(out).code).toBe("upload_type_refused");
  });

  it("refuses a body over 10 MB with 413", async () => {
    const { out } = await call("POST", "/uploads", {
      body: Buffer.alloc(UPLOAD_MAX_FILE_BYTES + 1, 0x61),
      headers: { "X-Upload-Filename": "big.txt" },
    });
    expect(out.status).toBe(413);
    expect(json(out).code).toBe("upload_too_large");
  });
});

describe("GET /uploads and GET/DELETE /uploads/:name", () => {
  it("lists uploads", async () => {
    await saveUpload("notes.md", Buffer.from("# a"));
    const { out } = await call("GET", "/uploads");
    expect(out.status).toBe(200);
    const body = json(out) as { uploads: Array<{ name: string }> };
    expect(body.uploads.map((u) => u.name)).toEqual(["notes.md"]);
  });

  it("downloads as an attachment, never inline", async () => {
    await saveUpload("notes.md", Buffer.from("# a <script>x</script>"));
    const { out } = await call("GET", "/uploads/notes.md");
    expect(out.status).toBe(200);
    expect(out.body.toString("utf8")).toBe("# a <script>x</script>");
    expect(out.headers["Content-Disposition"]).toBe(
      'attachment; filename="notes.md"',
    );
    // A generic type: nothing a browser would choose to render.
    expect(out.headers["Content-Type"]).toBe("application/octet-stream");
    expect(out.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(out.headers["Content-Security-Policy"]).toContain("sandbox");
  });

  it("a percent-encoded name with a space round-trips", async () => {
    await saveUpload("my notes.md", Buffer.from("# a"));
    const { out } = await call("GET", "/uploads/my%20notes.md");
    expect(out.status).toBe(200);
    expect(out.headers["Content-Disposition"]).toBe(
      'attachment; filename="my notes.md"',
    );
  });

  it("refuses traversal on download", async () => {
    // The uploads dir must exist, or a broken guard would 404 by accident.
    await saveUpload("notes.md", Buffer.from("# a"));
    writeFileSync(path.join(home, "secret.txt"), "SECRET");
    for (const url of [
      "/uploads/..%2F..%2Fsecret.txt",
      "/uploads/%2E%2E",
      "/uploads/.hidden",
    ]) {
      const { handled, out } = await call("GET", url);
      // `%2E%2E` is a dot-segment the URL parser resolves before routing, so
      // that one never reaches this route at all.
      if (handled) expect([400, 404]).toContain(out.status);
      expect(out.body.toString("utf8")).not.toContain("SECRET");
    }
  });

  it.skipIf(!POSIX)("never serves a symlink", async () => {
    mkdirSync(uploadsDir(), { recursive: true });
    writeFileSync(path.join(home, "secret.txt"), "SECRET");
    symlinkSync(
      path.join(home, "secret.txt"),
      path.join(uploadsDir(), "s.txt"),
    );
    const { out } = await call("GET", "/uploads/s.txt");
    expect(out.status).toBe(404);
    expect(out.body.toString("utf8")).not.toContain("SECRET");
  });

  it("deletes", async () => {
    await saveUpload("notes.md", Buffer.from("# a"));
    const del = await call("DELETE", "/uploads/notes.md");
    expect(del.out.status).toBe(200);
    const again = await call("GET", "/uploads/notes.md");
    expect(again.out.status).toBe(404);
  });

  it("does not claim unrelated paths", async () => {
    expect((await call("GET", "/uploadsx")).handled).toBe(false);
    expect((await call("PUT", "/uploads/x.txt")).handled).toBe(false);
  });
});
