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

  it("concurrent writes to the same target both succeed (no temp collision)", async () => {
    const p = path.join(dir, "concurrent.txt");
    // 10 parallel writes — last writer wins, but every individual write
    // must complete without an EEXIST or "no such file" error on a
    // shared temp path.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => writeFileAtomic(p, `v${i}`)),
    );
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(0);
    expect(readdirSync(dir).filter((e) => e.includes(".tmp."))).toEqual([]);
    // Target ends up with one of the written values
    expect(readFileSync(p, "utf-8")).toMatch(/^v\d$/);
  });
});
