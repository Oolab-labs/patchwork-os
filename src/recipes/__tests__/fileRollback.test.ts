import {
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

  it("records absent (not the symlink target's content) for a symlinked path", () => {
    const real = path.join(workDir, "real.md");
    writeFileSync(real, "secret");
    const link = path.join(workDir, "link.md");
    symlinkSync(real, link);
    const log = new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });
    log.capturePreImage(link);
    expect(log.rows()).toEqual([
      { path: link, hadContent: false, content: null },
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
});
