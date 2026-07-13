import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRollbackLog, rollbackFileWrites } from "../fileRollback.js";

let ledgerDir: string;
let workDir: string;

beforeEach(() => {
  ledgerDir = mkdtempSync(path.join(os.tmpdir(), "rollback-ledger-"));
  workDir = mkdtempSync(path.join(os.tmpdir(), "rollback-work-"));
});

afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("FileRollbackLog.capturePreImage", () => {
  it("records hadContent=true + the prior content for an existing file", () => {
    const target = path.join(workDir, "a.md");
    writeFileSync(target, "original");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target);
    expect(log.rows()).toEqual([
      { path: target, hadContent: true, content: "original" },
    ]);
  });

  it("records hadContent=false for a file that did not exist", () => {
    const target = path.join(workDir, "missing.md");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target);
    expect(log.rows()).toEqual([
      { path: target, hadContent: false, content: null },
    ]);
  });

  it("only captures the FIRST pre-image per path within a scope", () => {
    const target = path.join(workDir, "a.md");
    writeFileSync(target, "v1");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target);
    writeFileSync(target, "v2"); // simulate the step's write
    log.capturePreImage(target); // a second step touching the same path
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0]?.content).toBe("v1");
  });

  it("keeps different paths independent", () => {
    const a = path.join(workDir, "a.md");
    const b = path.join(workDir, "b.md");
    writeFileSync(a, "A");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(a);
    log.capturePreImage(b);
    expect(
      log
        .rows()
        .map((r) => r.path)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it("keeps different scopes independent", () => {
    const target = path.join(workDir, "a.md");
    writeFileSync(target, "v1");
    const logA = new FileRollbackLog({ dir: ledgerDir, scopeKey: "scope-a" });
    logA.capturePreImage(target);
    const logB = new FileRollbackLog({ dir: ledgerDir, scopeKey: "scope-b" });
    expect(logB.rows()).toEqual([]);
  });

  it("resuming the same scope does not re-capture an already-recorded path", () => {
    const target = path.join(workDir, "a.md");
    writeFileSync(target, "original");
    const log1 = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log1.capturePreImage(target);
    writeFileSync(target, "mutated-mid-run");
    // A fresh instance for the SAME scope (e.g. a retried attempt) must load
    // the existing capture and refuse to overwrite it with the mutated state.
    const log2 = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log2.capturePreImage(target);
    expect(log2.rows()).toEqual([
      { path: target, hadContent: true, content: "original" },
    ]);
  });

  it("marks a symlinked path uncertain (not the symlink target's content, and not 'absent' either)", () => {
    const real = path.join(workDir, "real.md");
    writeFileSync(real, "secret");
    const link = path.join(workDir, "link.md");
    symlinkSync(real, link);
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(link);
    // NOT recorded as hadContent:false/"absent" — the subsequent write
    // goes THROUGH the symlink and mutates the real target, so treating
    // this as "didn't exist" would make rollback delete the symlink and
    // report false success while the target's real prior content (never
    // captured) is permanently lost. `uncertain: true` makes rollback
    // fail loudly for this path instead of guessing.
    expect(log.rows()).toEqual([
      { path: link, hadContent: false, content: null, uncertain: true },
    ]);
  });
});

describe("rollbackFileWrites", () => {
  it("restores a modified file to its pre-image content", () => {
    const target = path.join(workDir, "a.md");
    writeFileSync(target, "original");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target);
    writeFileSync(target, "modified by the run");

    const result = rollbackFileWrites({ dir: ledgerDir, scopeKey: "s1" });
    expect(result.restored).toEqual([target]);
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe("original");
  });

  it("deletes a file that did not exist before the run", () => {
    const target = path.join(workDir, "new.md");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target); // captured before the write below
    writeFileSync(target, "created by the run");

    const result = rollbackFileWrites({ dir: ledgerDir, scopeKey: "s1" });
    expect(result.deleted).toEqual([target]);
    expect(result.restored).toEqual([]);
    expect(() => readFileSync(target, "utf-8")).toThrow();
  });

  it("rolls back multiple files from the same attempt", () => {
    const modified = path.join(workDir, "modified.md");
    const created = path.join(workDir, "created.md");
    writeFileSync(modified, "before");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(modified);
    log.capturePreImage(created);
    writeFileSync(modified, "after");
    writeFileSync(created, "after");

    const result = rollbackFileWrites({ dir: ledgerDir, scopeKey: "s1" });
    expect(result.restored.sort()).toEqual([modified].sort());
    expect(result.deleted.sort()).toEqual([created].sort());
    expect(readFileSync(modified, "utf-8")).toBe("before");
    expect(() => readFileSync(created, "utf-8")).toThrow();
  });

  it("does not touch files from a DIFFERENT scope", () => {
    const targetA = path.join(workDir, "a.md");
    const targetB = path.join(workDir, "b.md");
    writeFileSync(targetA, "a-before");
    writeFileSync(targetB, "b-before");
    const logA = new FileRollbackLog({ dir: ledgerDir, scopeKey: "scope-a" });
    logA.capturePreImage(targetA);
    const logB = new FileRollbackLog({ dir: ledgerDir, scopeKey: "scope-b" });
    logB.capturePreImage(targetB);
    writeFileSync(targetA, "a-after");
    writeFileSync(targetB, "b-after");

    const result = rollbackFileWrites({ dir: ledgerDir, scopeKey: "scope-a" });
    expect(result.restored).toEqual([targetA]);
    expect(readFileSync(targetA, "utf-8")).toBe("a-before");
    expect(readFileSync(targetB, "utf-8")).toBe("b-after"); // untouched
  });

  it("is a no-op (empty result) for a scope with no captured rows", () => {
    const result = rollbackFileWrites({
      dir: ledgerDir,
      scopeKey: "never-used",
    });
    expect(result).toEqual({ restored: [], deleted: [], failed: [] });
  });

  it("marks capture uncertain (not 'absent') when lstat fails with something other than ENOENT", () => {
    // A path whose parent directory is itself a plain FILE (not a
    // directory) makes lstatSync throw ENOTDIR, not ENOENT — capture must
    // NOT conflate that with "genuinely didn't exist" (the file may well
    // exist; we just couldn't stat it for an unrelated reason), so this
    // is recorded `uncertain` and rollback reports it as failed rather
    // than silently treating "couldn't check" as "safe to delete".
    const blocker = path.join(workDir, "blocker");
    writeFileSync(blocker, "im-a-file-not-a-dir");
    const target = path.join(blocker, "nested", "note.md");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target);
    expect(log.rows()).toEqual([
      { path: target, hadContent: false, content: null, uncertain: true },
    ]);

    const result = rollbackFileWrites({ dir: ledgerDir, scopeKey: "s1" });
    expect(result.deleted).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(target);
  });

  it("records a per-file failure when restoring content whose parent dir got replaced by a file", () => {
    // Capture happens while `nested` is a real directory (hadContent=true
    // succeeds normally), then `nested` is replaced with a plain FILE
    // before rollback runs — mkdirSync(dirname, {recursive:true}) then
    // throws instead of silently succeeding, exercising the catch branch
    // in rollbackFileWrites without needing filesystem permissions.
    const nestedDir = path.join(workDir, "nested");
    mkdirSync(nestedDir, { recursive: true });
    const target = path.join(nestedDir, "note.md");
    writeFileSync(target, "original");
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(target);
    expect(log.rows()).toEqual([
      { path: target, hadContent: true, content: "original" },
    ]);

    rmSync(nestedDir, { recursive: true, force: true });
    writeFileSync(nestedDir, "now a file, not a directory");

    const result = rollbackFileWrites({ dir: ledgerDir, scopeKey: "s1" });
    expect(result.restored).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(target);
  });
});

describe("FileRollbackLog directory safety", () => {
  it("throws when dir is not an absolute path", () => {
    expect(
      () => new FileRollbackLog({ dir: "relative/path", scopeKey: "s1" }),
    ).toThrow(/absolute/);
  });

  it("throws when dir contains a null byte", () => {
    expect(
      () => new FileRollbackLog({ dir: `${workDir}/a\0b`, scopeKey: "s1" }),
    ).toThrow(/null bytes/);
  });

  it("throws when dir is empty", () => {
    expect(() => new FileRollbackLog({ dir: "", scopeKey: "s1" })).toThrow(
      /non-empty/,
    );
  });

  it("throws when dir is a symlink", async () => {
    const { symlinkSync: symlink } = await import("node:fs");
    const realDir = mkdtempSync(path.join(os.tmpdir(), "rollback-real-"));
    const linkDir = path.join(os.tmpdir(), `rollback-link-${Date.now()}`);
    symlink(realDir, linkDir, "dir");
    try {
      expect(
        () => new FileRollbackLog({ dir: linkDir, scopeKey: "s1" }),
      ).toThrow(/symlink/);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

describe("FileRollbackLog rotation", () => {
  it("rotates the log once it exceeds the size cap, preserving the most recent rows", () => {
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    // Force append()'s size check to trip: capture one huge pre-image
    // (content alone exceeds the 1MB cap), then a second capture triggers
    // the pre-append statSync check that calls rotate().
    const bigPath = path.join(workDir, "big.md");
    writeFileSync(bigPath, "x".repeat(1_100_000));
    log.capturePreImage(bigPath);

    const smallPath = path.join(workDir, "small.md");
    writeFileSync(smallPath, "small");
    log.capturePreImage(smallPath);

    // Rotation trims to MAX_PERSIST_LINES but both rows still fit (well
    // under 10k lines) — both must survive the rotation.
    const rows = log.rows().map((r) => r.path);
    expect(rows.sort()).toEqual([bigPath, smallPath].sort());
  });
});
