import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  _cleanupExpiredTransactions,
  createTransactionTools,
  TRANSACTION_TTL_MS,
} from "../transaction.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function isError(r: { isError?: boolean }) {
  return r.isError === true;
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "transaction-test-"));
  fs.writeFileSync(path.join(workspace, "a.ts"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(workspace, "b.ts"), "foo\nbar\nbaz\n");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("transaction tools", () => {
  it("beginTransaction returns a transactionId", async () => {
    const { beginTransaction } = createTransactionTools(workspace);
    const result = parse(await beginTransaction.handler({}));
    expect(typeof result.transactionId).toBe("string");
    expect(result.transactionId.length).toBeGreaterThan(0);
  });

  it("beginTransaction uses custom id when provided", async () => {
    const { beginTransaction } = createTransactionTools(workspace);
    const result = parse(
      await beginTransaction.handler({ transactionId: "my-tx-1" }),
    );
    expect(result.transactionId).toBe("my-tx-1");
  });

  it("stageEdit errors when transaction not found", async () => {
    const { stageEdit } = createTransactionTools(workspace);
    const result = await stageEdit.handler({
      transactionId: "no-such-tx",
      filePath: "a.ts",
      operation: "lineRange",
      startLine: 1,
      endLine: 1,
      newContent: "x",
    });
    expect(isError(result)).toBe(true);
  });

  it("stageEdit returns staged count after staging", async () => {
    const { beginTransaction, stageEdit } = createTransactionTools(workspace);
    const { transactionId } = parse(
      await beginTransaction.handler({ transactionId: "stage-test" }),
    );

    const staged = parse(
      await stageEdit.handler({
        transactionId,
        filePath: "a.ts",
        operation: "lineRange",
        startLine: 2,
        endLine: 2,
        newContent: "REPLACED",
      }),
    );
    expect(staged.staged).toBe(1);
  });

  it("commitTransaction writes files and removes transaction", async () => {
    const { beginTransaction, stageEdit, commitTransaction } =
      createTransactionTools(workspace);

    const txResult = parse(
      await beginTransaction.handler({ transactionId: "commit-test" }),
    );
    const { transactionId } = txResult;

    await stageEdit.handler({
      transactionId,
      filePath: "b.ts",
      operation: "searchReplace",
      search: "foo",
      replace: "FOO",
    });

    const result = parse(await commitTransaction.handler({ transactionId }));
    expect(result.committed).toBe(1);
    expect(result.files.length).toBe(1);

    const contents = fs.readFileSync(path.join(workspace, "b.ts"), "utf-8");
    expect(contents).toContain("FOO");

    // Transaction should be gone — calling again should error
    const again = await commitTransaction.handler({ transactionId });
    expect(isError(again)).toBe(true);
  });

  it("rollbackTransaction discards edits without writing", async () => {
    const originalContent = "original\ncontent\n";
    const testFile = path.join(workspace, "rollback.ts");
    fs.writeFileSync(testFile, originalContent);

    const { beginTransaction, stageEdit, rollbackTransaction } =
      createTransactionTools(workspace);

    const { transactionId } = parse(
      await beginTransaction.handler({ transactionId: "rollback-test" }),
    );

    await stageEdit.handler({
      transactionId,
      filePath: "rollback.ts",
      operation: "lineRange",
      startLine: 1,
      endLine: 1,
      newContent: "SHOULD_NOT_BE_WRITTEN",
    });

    const result = parse(await rollbackTransaction.handler({ transactionId }));
    expect(result.rolledBack).toBe(1);

    const afterRollback = fs.readFileSync(testFile, "utf-8");
    expect(afterRollback).toBe(originalContent);
  });

  it("beginTransaction errors on duplicate id", async () => {
    const { beginTransaction } = createTransactionTools(workspace);
    await beginTransaction.handler({ transactionId: "dup-tx-2" });
    const result = await beginTransaction.handler({
      transactionId: "dup-tx-2",
    });
    expect(isError(result)).toBe(true);
  });

  it("stageEdit errors on missing file", async () => {
    const { beginTransaction, stageEdit } = createTransactionTools(workspace);
    const { transactionId } = parse(
      await beginTransaction.handler({ transactionId: "missing-file-tx" }),
    );

    const result = await stageEdit.handler({
      transactionId,
      filePath: "does_not_exist.ts",
      operation: "lineRange",
      startLine: 1,
      endLine: 1,
      newContent: "x",
    });
    expect(isError(result)).toBe(true);
  });
});

describe("transaction TTL", () => {
  it("stageEdit returns isError for an expired transaction", async () => {
    const { beginTransaction, stageEdit } = createTransactionTools(workspace);
    const { transactionId } = parse(
      await beginTransaction.handler({ transactionId: "ttl-stage-test" }),
    );

    // Manually backdate createdAt by mutating through the module internals
    // We monkey-patch Date.now to simulate time passage
    const realNow = Date.now;
    Date.now = () => realNow() + TRANSACTION_TTL_MS + 1000;
    try {
      const result = await stageEdit.handler({
        transactionId,
        filePath: "a.ts",
        operation: "lineRange",
        startLine: 1,
        endLine: 1,
        newContent: "x",
      });
      expect(isError(result)).toBe(true);
      expect(result.content[0].text).toContain("expired");
    } finally {
      Date.now = realNow;
    }
  });

  it("commitTransaction returns isError for an expired transaction", async () => {
    const { beginTransaction, commitTransaction } =
      createTransactionTools(workspace);
    const { transactionId } = parse(
      await beginTransaction.handler({ transactionId: "ttl-commit-test" }),
    );

    const realNow = Date.now;
    Date.now = () => realNow() + TRANSACTION_TTL_MS + 1000;
    try {
      const result = await commitTransaction.handler({ transactionId });
      expect(isError(result)).toBe(true);
      expect(result.content[0].text).toContain("expired");
    } finally {
      Date.now = realNow;
    }
  });

  it("_cleanupExpiredTransactions removes expired entries and returns count", async () => {
    const { beginTransaction } = createTransactionTools(workspace);
    await beginTransaction.handler({ transactionId: "cleanup-tx-1" });
    await beginTransaction.handler({ transactionId: "cleanup-tx-2" });

    const realNow = Date.now;
    Date.now = () => realNow() + TRANSACTION_TTL_MS + 1000;
    try {
      const removed = _cleanupExpiredTransactions();
      expect(removed).toBeGreaterThanOrEqual(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("_cleanupExpiredTransactions does not remove fresh transactions", async () => {
    const { beginTransaction, rollbackTransaction } =
      createTransactionTools(workspace);
    await beginTransaction.handler({ transactionId: "fresh-tx" });

    const removed = _cleanupExpiredTransactions();
    expect(removed).toBe(0);

    // Clean up
    await rollbackTransaction.handler({ transactionId: "fresh-tx" });
  });
});
