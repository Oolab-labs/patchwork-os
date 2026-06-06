/**
 * EBUSY/EPERM retry in writeFileAtomicSync.
 *
 * On Windows, Defender can hold a brief exclusive handle on the target file
 * during a rename-over-open → EPERM or EBUSY. The fix adds a short retry loop
 * (up to 3 retries at ~50 ms each) before giving up.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Save real fs functions before mocking ────────────────────────────────────
// vi.hoisted runs before vi.mock factory; store refs so mock can call through.

const saved = vi.hoisted(() => ({
  renameSync: null as ((src: string, dst: string) => void) | null,
  unlinkSync: null as ((p: string) => void) | null,
}));

const mockFns = vi.hoisted(() => ({
  renameSync: vi.fn<(src: string, dst: string) => void>(),
  unlinkSync: vi.fn<(p: string) => void>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  saved.renameSync = (actual as any).renameSync.bind(actual);
  saved.unlinkSync = (actual as any).unlinkSync.bind(actual);
  return {
    ...actual,
    renameSync: mockFns.renameSync,
    unlinkSync: mockFns.unlinkSync,
    default: {
      ...actual,
      renameSync: mockFns.renameSync,
      unlinkSync: mockFns.unlinkSync,
    },
  };
});

import { writeFileAtomicSync } from "../writeFileAtomic.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(nodePath.join(tmpdir(), "pw-ebusy-"));
  // Default: call through to real implementations
  mockFns.renameSync.mockImplementation(saved.renameSync!);
  mockFns.unlinkSync.mockImplementation(saved.unlinkSync!);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("writeFileAtomicSync — EPERM/EBUSY retry (rename-over-open)", () => {
  it("retries and succeeds when renameSync throws EPERM on first attempt", () => {
    const target = nodePath.join(dir, "tok.json");
    writeFileSync(target, "original");

    let callCount = 0;
    mockFns.renameSync.mockImplementation((src: string, dst: string) => {
      callCount++;
      if (callCount === 1)
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      saved.renameSync!(src, dst);
    });

    expect(() => writeFileAtomicSync(target, "updated")).not.toThrow();
    expect(readFileSync(target, "utf-8")).toBe("updated");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("throws after all retries exhausted (permanent EPERM)", () => {
    const target = nodePath.join(dir, "tok.json");
    writeFileSync(target, "original");

    mockFns.renameSync.mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });

    expect(() => writeFileAtomicSync(target, "updated")).toThrow(/EPERM/);
  });

  it("does not retry on non-retryable errors (EACCES)", () => {
    const target = nodePath.join(dir, "tok.json");
    writeFileSync(target, "original");

    let callCount = 0;
    mockFns.renameSync.mockImplementation(() => {
      callCount++;
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });

    expect(() => writeFileAtomicSync(target, "updated")).toThrow(/EACCES/);
    expect(callCount).toBe(1);
  });

  it("retries on EBUSY (Defender holds read handle)", () => {
    const target = nodePath.join(dir, "checkpoint.json");
    writeFileSync(target, "v1");

    let callCount = 0;
    mockFns.renameSync.mockImplementation((src: string, dst: string) => {
      callCount++;
      if (callCount <= 2)
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      saved.renameSync!(src, dst);
    });

    expect(() => writeFileAtomicSync(target, "v2")).not.toThrow();
    expect(readFileSync(target, "utf-8")).toBe("v2");
  });
});
