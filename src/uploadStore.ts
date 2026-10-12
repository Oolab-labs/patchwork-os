/**
 * Workspace uploads — documents a user hands the runtime (notes, a receipt
 * PDF, a photo) so a recipe can work over them with a `type: file` input
 * (`src/recipes/fileInputs.ts`). HTTP surface: `src/uploadsRoutes.ts`.
 *
 * A plain directory, `patchworkPath("uploads")`. The NAME and the BYTES both
 * arrive from the network, so every rule below is a refusal:
 *
 *   - **Names.** A stored name is a plain file name: ASCII letters, digits,
 *     space and `. _ -`, starting with a letter or digit, at most 128 chars,
 *     with an allowed extension. A client name carrying a separator, `..`, a
 *     leading dot or a control character is REFUSED (that is an attempt, not
 *     a typo); any other character outside the set is replaced with `_`, so
 *     "receipt (1).pdf" uploads as "receipt _1_.pdf".
 *   - **Never through a symlink.** The directory itself must not be a symlink;
 *     an entry is listed, served, resolved or deleted only when `lstat` says it
 *     is a regular file; a write never replaces an existing entry (it is
 *     linked into place, which fails rather than clobbers).
 *   - **Atomic, private writes.** Bytes go to a `0o600` temp file in the same
 *     directory, then are hard-linked to the final name.
 *   - **Caps refuse, never truncate.** 10 MB per file, 200 MB per workspace.
 *   - **Types by extension AND content.** txt, md, csv, json, pdf, png,
 *     jpg/jpeg, webp. Binary types must start with their magic bytes; text
 *     types must be valid UTF-8 with no NUL and must not open as HTML/SVG/XML.
 *     Everything else — html, svg, scripts, executables — is refused.
 *   - **A collision gets a numeric suffix** (`notes-1.txt`), never an
 *     overwrite.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { patchworkPath } from "./patchworkHome.js";

/** Per-file cap. */
export const UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Per-workspace cap over every stored upload. */
export const UPLOAD_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** Longest stored name. */
const MAX_NAME_LENGTH = 128;

/** The uploads directory. Read per call — `PATCHWORK_HOME` may change. */
export function uploadsDir(): string {
  return patchworkPath("uploads");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Sniff = (bytes: Buffer) => boolean;

const startsWith =
  (magic: number[]): Sniff =>
  (b) =>
    b.length >= magic.length && magic.every((m, i) => b[i] === m);

const PDF_MAGIC = startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const PNG_MAGIC = startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_MAGIC = startsWith([0xff, 0xd8, 0xff]);
const WEBP_MAGIC: Sniff = (b) =>
  b.length >= 12 &&
  b.toString("latin1", 0, 4) === "RIFF" &&
  b.toString("latin1", 8, 12) === "WEBP";

/** Markup a browser would render, if the text ever reached one as a page. */
const MARKUP_OPENING =
  /^(?:<!doctype\s+html|<html|<svg|<\?xml|<head|<body|<script)/i;

function decodeUtf8Strict(b: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

const TEXT_SNIFF: Sniff = (b) => {
  if (b.includes(0)) return false;
  const text = decodeUtf8Strict(b);
  if (text === null) return false;
  return !MARKUP_OPENING.test(text.replace(/^﻿/, "").trimStart());
};

const JSON_SNIFF: Sniff = (b) => {
  if (!TEXT_SNIFF(b)) return false;
  try {
    JSON.parse((decodeUtf8Strict(b) ?? "").replace(/^﻿/, ""));
    return true;
  } catch {
    return false;
  }
};

const UPLOAD_TYPES: Readonly<
  Record<string, { contentType: string; sniff: Sniff }>
> = {
  txt: { contentType: "text/plain; charset=utf-8", sniff: TEXT_SNIFF },
  md: { contentType: "text/markdown; charset=utf-8", sniff: TEXT_SNIFF },
  csv: { contentType: "text/csv; charset=utf-8", sniff: TEXT_SNIFF },
  json: { contentType: "application/json", sniff: JSON_SNIFF },
  pdf: { contentType: "application/pdf", sniff: PDF_MAGIC },
  png: { contentType: "image/png", sniff: PNG_MAGIC },
  jpg: { contentType: "image/jpeg", sniff: JPG_MAGIC },
  jpeg: { contentType: "image/jpeg", sniff: JPG_MAGIC },
  webp: { contentType: "image/webp", sniff: WEBP_MAGIC },
};

/** The allowed extensions, for messages. */
export const UPLOAD_EXTENSIONS: readonly string[] = Object.keys(UPLOAD_TYPES);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function typeOf(name: string) {
  const ext = extensionOf(name);
  return Object.hasOwn(UPLOAD_TYPES, ext) ? UPLOAD_TYPES[ext] : undefined;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
// Device names Windows will not let a file have, whatever the extension.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

/**
 * Why `name` is not a valid STORED upload name, or null when it is. Strict —
 * no sanitising — because this is what a run input value and a URL segment
 * are held to: a name that would need changing is not the name of an upload.
 */
export function uploadNameError(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return "must be a non-empty file name";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `must be at most ${MAX_NAME_LENGTH} characters`;
  }
  if (!NAME_RE.test(name)) {
    return "must be a plain file name: letters, digits, spaces and . _ - only, starting with a letter or digit";
  }
  if (name.includes("..")) return 'must not contain ".."';
  if (/[ .]$/.test(name)) return "must not end with a space or a dot";
  if (WINDOWS_RESERVED.test(name)) return "is a reserved device name";
  if (!typeOf(name)) {
    return `must end in one of: ${UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(", ")}`;
  }
  return null;
}

export type UploadErrorCode =
  | "upload_name_missing"
  | "upload_name_invalid"
  | "upload_type_refused"
  | "upload_content_mismatch"
  | "upload_empty"
  | "upload_too_large"
  | "upload_quota_exceeded"
  | "upload_not_found"
  | "upload_store_unavailable";

export interface UploadFailure {
  ok: false;
  status: number;
  code: UploadErrorCode;
  error: string;
}

function fail(
  status: number,
  code: UploadErrorCode,
  error: string,
): UploadFailure {
  return { ok: false, status, code, error };
}

// C0, DEL and C1 — never part of a name.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Turn a client-supplied file name into a stored one. Refuses outright what
 * can only be an attempt — a separator, `..`, a leading dot, a control
 * character — and replaces any other character outside the stored-name set
 * with `_`.
 */
export function sanitizeUploadName(
  raw: string,
): { ok: true; name: string } | UploadFailure {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail(400, "upload_name_missing", "A file name is required");
  }
  if (
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("..") ||
    raw.startsWith(".") ||
    CONTROL_RE.test(raw)
  ) {
    return fail(
      400,
      "upload_name_invalid",
      "The file name must be a plain name — no path separators, no '..', no leading dot and no control characters",
    );
  }
  const name = raw
    .normalize("NFC")
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, "_");
  const reason = uploadNameError(name);
  if (reason) {
    // The extension is the most common reason, and it is a TYPE refusal.
    if (!typeOf(name)) {
      return fail(
        415,
        "upload_type_refused",
        `This file type is not accepted. Allowed: ${UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(", ")}`,
      );
    }
    return fail(400, "upload_name_invalid", `The file name ${reason}`);
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/**
 * Create the uploads directory (0o700) if needed, and refuse to use it when
 * it is anything but a real directory — a symlinked uploads dir would turn
 * every write into a write somewhere else.
 */
async function ensureDir(): Promise<string | UploadFailure> {
  const dir = uploadsDir();
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    return fail(
      500,
      "upload_store_unavailable",
      "The uploads directory is not a plain directory",
    );
  }
  return dir;
}

function dirIsUsable(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export interface UploadEntry {
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  uploadedAt: string;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * sha256 by (name, inode, size, mtime). A listing would otherwise re-hash up to
 * 200 MB on every poll; any change to the file changes the key.
 */
const hashCache = new Map<string, string>();

async function entryFor(
  dir: string,
  name: string,
): Promise<UploadEntry | null> {
  const full = path.join(dir, name);
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) return null;
  const key = `${name}\u0000${st.ino}\u0000${st.size}\u0000${st.mtimeMs}`;
  let sha = hashCache.get(key);
  if (!sha) {
    const bytes = await readFileNoFollow(full);
    if (!bytes) return null;
    sha = sha256Of(bytes);
    hashCache.set(key, sha);
  }
  return {
    name,
    size: st.size,
    sha256: sha,
    contentType: typeOf(name)?.contentType ?? "application/octet-stream",
    uploadedAt: st.mtime.toISOString(),
  };
}

/** Read a regular file without following a symlink at the last component. */
async function readFileNoFollow(full: string): Promise<Buffer | null> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(full, flags);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    return await fh.readFile();
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Every stored upload, newest first. A missing directory lists as empty. */
export async function listUploads(): Promise<UploadEntry[]> {
  const dir = uploadsDir();
  if (!dirIsUsable(dir)) return [];
  const out: UploadEntry[] = [];
  for (const name of await readdir(dir)) {
    if (uploadNameError(name) !== null) continue;
    const entry = await entryFor(dir, name);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return out;
}

async function totalBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir)) {
    const st = await lstat(path.join(dir, name)).catch(() => null);
    // Everything in the directory counts, temp files included: the cap is
    // about the disk, not about what the listing shows.
    if (st?.isFile()) total += st.size;
  }
  return total;
}

function withSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

// One save at a time per process, so two concurrent uploads cannot both pass
// the total-size check against the same starting total.
let saveChain: Promise<unknown> = Promise.resolve();

export interface SaveUploadOptions {
  /** Test seam; defaults to UPLOAD_MAX_FILE_BYTES. */
  maxFileBytes?: number;
  /** Test seam; defaults to UPLOAD_MAX_TOTAL_BYTES. */
  maxTotalBytes?: number;
}

export type SaveUploadResult =
  | { ok: true; upload: UploadEntry; renamedFrom?: string }
  | UploadFailure;

/** Validate and store one upload. */
export function saveUpload(
  rawName: string,
  bytes: Buffer,
  opts: SaveUploadOptions = {},
): Promise<SaveUploadResult> {
  const run = saveChain.then(() => saveUploadNow(rawName, bytes, opts));
  saveChain = run.catch(() => {});
  return run;
}

async function saveUploadNow(
  rawName: string,
  bytes: Buffer,
  opts: SaveUploadOptions,
): Promise<SaveUploadResult> {
  const maxFile = opts.maxFileBytes ?? UPLOAD_MAX_FILE_BYTES;
  const maxTotal = opts.maxTotalBytes ?? UPLOAD_MAX_TOTAL_BYTES;
  const named = sanitizeUploadName(rawName);
  if (!named.ok) return named;
  const type = typeOf(named.name);
  if (!type) {
    return fail(415, "upload_type_refused", "This file type is not accepted");
  }
  if (bytes.length === 0) {
    return fail(400, "upload_empty", "The upload is empty");
  }
  if (bytes.length > maxFile) {
    return fail(
      413,
      "upload_too_large",
      `The file is larger than the ${maxFile}-byte limit`,
    );
  }
  if (!type.sniff(bytes)) {
    return fail(
      415,
      "upload_content_mismatch",
      `The file's content is not a valid .${extensionOf(named.name)} file`,
    );
  }
  const dir = await ensureDir();
  if (typeof dir !== "string") return dir;
  const used = await totalBytes(dir);
  if (used + bytes.length > maxTotal) {
    return fail(
      413,
      "upload_quota_exceeded",
      `Uploads are limited to ${maxTotal} bytes per workspace (${used} in use); delete an upload first`,
    );
  }

  const temp = path.join(
    dir,
    `.upload-${randomBytes(8).toString("hex")}.partial`,
  );
  const fh = await open(temp, "wx", 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    for (let n = 0; n < 1000; n++) {
      const candidate = withSuffix(named.name, n);
      if (uploadNameError(candidate) !== null) break;
      try {
        // link() never replaces an existing entry — file, dir or symlink —
        // so the collision check and the write are one atomic step.
        await link(temp, path.join(dir, candidate));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      const entry = await entryFor(dir, candidate);
      if (!entry) break;
      return {
        ok: true,
        upload: entry,
        ...(candidate !== rawName && { renamedFrom: rawName }),
      };
    }
    return fail(
      409,
      "upload_name_invalid",
      "Could not find a free name for this upload",
    );
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Read one upload for download. */
export async function readUpload(
  name: string,
): Promise<{ ok: true; bytes: Buffer; entry: UploadEntry } | UploadFailure> {
  if (uploadNameError(name) !== null) {
    return fail(400, "upload_name_invalid", "Invalid upload name");
  }
  const dir = uploadsDir();
  if (!dirIsUsable(dir)) return fail(404, "upload_not_found", "Not found");
  const full = path.join(dir, name);
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) return fail(404, "upload_not_found", "Not found");
  const bytes = await readFileNoFollow(full);
  if (!bytes) return fail(404, "upload_not_found", "Not found");
  const entry = await entryFor(dir, name);
  if (!entry) return fail(404, "upload_not_found", "Not found");
  return { ok: true, bytes, entry };
}

/** Delete one upload. A symlink or directory is never touched. */
export async function deleteUpload(
  name: string,
): Promise<{ ok: true } | UploadFailure> {
  if (uploadNameError(name) !== null) {
    return fail(400, "upload_name_invalid", "Invalid upload name");
  }
  const dir = uploadsDir();
  if (!dirIsUsable(dir)) return fail(404, "upload_not_found", "Not found");
  const full = path.join(dir, name);
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) return fail(404, "upload_not_found", "Not found");
  await unlink(full);
  return { ok: true };
}

/**
 * The absolute path of an existing upload, for a `type: file` run input.
 * Synchronous because the run routes validate synchronously. Refuses anything
 * that is not a strict upload name of a regular file in a real uploads dir.
 */
export function resolveUploadPath(
  name: unknown,
):
  | { ok: true; name: string; path: string; size: number; sha256: string }
  | { ok: false; error: string } {
  const reason = uploadNameError(name);
  if (reason)
    return { ok: false, error: `is not an upload name: it ${reason}` };
  const dir = uploadsDir();
  if (!dirIsUsable(dir)) {
    return { ok: false, error: `names no upload ("${name}" does not exist)` };
  }
  const full = path.join(dir, name as string);
  let fd: number | undefined;
  try {
    const st = lstatSync(full);
    if (!st.isFile()) {
      return { ok: false, error: `names no upload ("${name}" does not exist)` };
    }
    fd = openSync(full, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      return { ok: false, error: `names no upload ("${name}" does not exist)` };
    }
    const bytes = readFileSync(fd);
    return {
      ok: true,
      name: name as string,
      path: full,
      size: fst.size,
      sha256: sha256Of(bytes),
    };
  } catch {
    return { ok: false, error: `names no upload ("${name}" does not exist)` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
