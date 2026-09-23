/**
 * Rollbackability is assessed BEFORE the authority decision and re-assessed
 * immediately before the write, from ONE inspection primitive shared with the
 * pre-image capture. `fs-write` used to be `reversible` by domain, so every
 * automated `file.write` flowed ungated on the strength of an undo that did not
 * exist: automated runs are never given a rollback log.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessRollbackability,
  FileRollbackLog,
  inspectRollbackState,
} from "../fileRollback.js";

let ledgerDir: string;
let workDir: string;

beforeEach(() => {
  ledgerDir = mkdtempSync(path.join(os.tmpdir(), "rbability-ledger-"));
  workDir = mkdtempSync(path.join(os.tmpdir(), "rbability-work-"));
});

afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const newLog = () => new FileRollbackLog({ dir: ledgerDir, scopeKey: "s1" });

describe("inspectRollbackState", () => {
  it("existing text file → existing-text with its exact content", () => {
    const p = path.join(workDir, "a.md");
    writeFileSync(p, "original");
    expect(inspectRollbackState(p)).toEqual({
      kind: "existing-text",
      content: "original",
    });
  });

  it("missing path → absent", () => {
    expect(inspectRollbackState(path.join(workDir, "nope.md"))).toEqual({
      kind: "absent",
    });
  });

  it("symlink → uncertain (never read through, never treated as absent)", () => {
    const target = path.join(workDir, "real.md");
    writeFileSync(target, "x");
    const link = path.join(workDir, "link.md");
    symlinkSync(target, link);
    expect(inspectRollbackState(link).kind).toBe("uncertain");
  });

  it("non-lossless binary → uncertain", () => {
    const p = path.join(workDir, "b.bin");
    writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    expect(inspectRollbackState(p).kind).toBe("uncertain");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "unreadable existing file → uncertain, not absent",
    () => {
      const p = path.join(workDir, "locked.md");
      writeFileSync(p, "secret");
      chmodSync(p, 0o000);
      try {
        expect(inspectRollbackState(p).kind).toBe("uncertain");
      } finally {
        chmodSync(p, 0o600);
      }
    },
  );
});

describe("assessRollbackability", () => {
  it("no rollback log → unavailable, whatever the target looks like", () => {
    const p = path.join(workDir, "a.md");
    writeFileSync(p, "original");
    expect(assessRollbackability(p, undefined)).toBe("unavailable");
    expect(assessRollbackability(path.join(workDir, "n.md"), undefined)).toBe(
      "unavailable",
    );
  });

  it("log present + existing text → confirmed", () => {
    const p = path.join(workDir, "a.md");
    writeFileSync(p, "original");
    expect(assessRollbackability(p, newLog())).toBe("confirmed");
  });

  it("log present + absent path → confirmed (undo = delete)", () => {
    expect(assessRollbackability(path.join(workDir, "n.md"), newLog())).toBe(
      "confirmed",
    );
  });

  it("log present + symlink → uncertain", () => {
    const target = path.join(workDir, "real.md");
    writeFileSync(target, "x");
    const link = path.join(workDir, "link.md");
    symlinkSync(target, link);
    expect(assessRollbackability(link, newLog())).toBe("uncertain");
  });

  it("a path already captured this scope reports the CAPTURED row's certainty, not today's file", () => {
    const target = path.join(workDir, "real.md");
    writeFileSync(target, "x");
    const link = path.join(workDir, "link.md");
    symlinkSync(target, link);
    const log = newLog();
    log.capturePreImage(link); // records an uncertain row
    // Even if the link is replaced by a plain file, rollback still rests on
    // the uncertain first capture — the first pre-image is what gets replayed.
    rmSync(link);
    writeFileSync(link, "now plain");
    expect(assessRollbackability(link, log)).toBe("uncertain");
  });

  it("a path already captured with a good pre-image stays confirmed after later writes", () => {
    const p = path.join(workDir, "a.md");
    writeFileSync(p, "original");
    const log = newLog();
    log.capturePreImage(p);
    writeFileSync(p, Buffer.from([0xff, 0xfe])); // now binary
    expect(assessRollbackability(p, log)).toBe("confirmed");
  });

  it("the captured-row certainty survives a resumed attempt (read back from disk)", () => {
    const target = path.join(workDir, "real.md");
    writeFileSync(target, "x");
    const link = path.join(workDir, "link.md");
    symlinkSync(target, link);
    newLog().capturePreImage(link);
    rmSync(link);
    writeFileSync(link, "now plain");
    expect(assessRollbackability(link, newLog())).toBe("uncertain");
  });
});

describe("capturePreImage reports what it did", () => {
  it("returns the same verdict assess gave, and persisted=true", () => {
    const p = path.join(workDir, "a.md");
    writeFileSync(p, "original");
    const log = newLog();
    expect(log.capturePreImage(p)).toEqual({
      rollbackability: "confirmed",
      persisted: true,
    });
  });

  it("symlink capture → uncertain", () => {
    const target = path.join(workDir, "real.md");
    writeFileSync(target, "x");
    const link = path.join(workDir, "link.md");
    symlinkSync(target, link);
    expect(newLog().capturePreImage(link).rollbackability).toBe("uncertain");
  });

  it("persisted=false when the row could not be written", () => {
    const p = path.join(workDir, "a.md");
    writeFileSync(p, "original");
    const log = newLog();
    // Make the log path a directory so appendFileSync fails.
    rmSync(ledgerDir, { recursive: true, force: true });
    mkdirSync(path.join(ledgerDir, "file_rollback.jsonl"), { recursive: true });
    expect(log.capturePreImage(p).persisted).toBe(false);
  });
});
