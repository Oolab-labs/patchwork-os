import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic, writeFileAtomicSync } from "../writeFileAtomic.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-write-atomic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("writeFileAtomicSync", () => {
  it("writes a new file", () => {
    const p = path.join(dir, "new.txt");
    writeFileAtomicSync(p, "hello");
    expect(readFileSync(p, "utf-8")).toBe("hello");
  });

  it("overwrites an existing file", () => {
    const p = path.join(dir, "exists.txt");
    writeFileSync(p, "old");
    writeFileAtomicSync(p, "new");
    expect(readFileSync(p, "utf-8")).toBe("new");
  });

  it("leaves no .tmp.* sibling after success", () => {
    const p = path.join(dir, "clean.txt");
    writeFileAtomicSync(p, "x");
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
    expect(entries).toContain("clean.txt");
  });

  it("respects mode option", () => {
    const p = path.join(dir, "moded.txt");
    writeFileAtomicSync(p, "x", { mode: 0o600 });
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("accepts Buffer data", () => {
    const p = path.join(dir, "buf.bin");
    writeFileAtomicSync(p, Buffer.from([0x01, 0x02, 0x03]));
    expect([...readFileSync(p)]).toEqual([0x01, 0x02, 0x03]);
  });
});

describe("writeFileAtomic (async)", () => {
  it("writes a new file", async () => {
    const p = path.join(dir, "new.txt");
    await writeFileAtomic(p, "hello");
    expect(readFileSync(p, "utf-8")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const p = path.join(dir, "exists.txt");
    writeFileSync(p, "old");
    await writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf-8")).toBe("new");
  });

  it("leaves no .tmp.* sibling after success", async () => {
    const p = path.join(dir, "clean.txt");
    await writeFileAtomic(p, "x");
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
    expect(entries).toContain("clean.txt");
  });

  it("aborts when signal fires; leaves target untouched", async () => {
    const p = path.join(dir, "abort.txt");
    writeFileSync(p, "original");
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeFileAtomic(p, "new", { signal: controller.signal }),
    ).rejects.toThrow();
    // Target must be unchanged when abort fires before the rename.
    expect(readFileSync(p, "utf-8")).toBe("original");
    // And no orphan temp.
    expect(readdirSync(dir).filter((e) => e.includes(".tmp."))).toEqual([]);
  });

  it("cleans up orphan tmp on rename failure", async () => {
    // Force the rename step to fail by making target dir read-only after
    // tmp is created. Easiest way: mock fs.promises.rename to throw.
    const fs = await import("node:fs");
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(new Error("simulated rename failure"));
    const p = path.join(dir, "fail.txt");
    await expect(writeFileAtomic(p, "x")).rejects.toThrow(/simulated/);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    // No target should exist
    expect(existsSync(p)).toBe(false);
    // No orphan temp
    expect(readdirSync(dir).filter((e) => e.includes(".tmp."))).toEqual([]);
  });

  it("concurrent writes don't collide on temp paths; target ends valid", async () => {
    const p = path.join(dir, "concurrent.txt");
    // 10 parallel writes — last writer wins. On POSIX `rename` is fully
    // atomic-replace; every call succeeds. On Windows, `MoveFileExW`
    // with REPLACE_EXISTING can race with itself when many writers
    // target the same path simultaneously and some will return EPERM /
    // EACCES. That's the documented Windows quirk for concurrent
    // rename-replace, not a bug in this helper — what we care about
    // is (a) no two writers ever collide on the same temp path
    // (uniqueness via pid + randomBytes), (b) at least one write makes
    // it through, and (c) the final on-disk content is a valid intact
    // payload (never torn). Audit 2026-05-17 — Windows CI flake on the
    // strict `failures.length === 0` form.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => writeFileAtomic(p, `v${i}`)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);
    // Any rejection must NOT be from temp-path collision (EEXIST on
    // `${target}.tmp.${pid}.${rand}`). EPERM / EACCES on the rename
    // step is the Windows-only race we tolerate.
    for (const r of results) {
      if (r.status === "rejected") {
        const msg = String(r.reason?.message ?? "");
        expect(msg).not.toMatch(/EEXIST.*\.tmp\./);
      }
    }
    expect(readdirSync(dir).filter((e) => e.includes(".tmp."))).toEqual([]);
    // Target ends up with one of the written values — not torn / empty.
    expect(readFileSync(p, "utf-8")).toMatch(/^v\d$/);
  });
});
