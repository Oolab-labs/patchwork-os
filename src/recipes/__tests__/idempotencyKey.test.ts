import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveIdempotencyKey, WriteEffectLedger } from "../idempotencyKey.js";

describe("deriveIdempotencyKey", () => {
  it("produces the same key for identical (toolId, params)", () => {
    const a = deriveIdempotencyKey("slack.postMessage", {
      channel: "#general",
      text: "hello",
    });
    const b = deriveIdempotencyKey("slack.postMessage", {
      channel: "#general",
      text: "hello",
    });
    expect(a).toBe(b);
  });

  it("produces the same key regardless of param key order", () => {
    const a = deriveIdempotencyKey("slack.postMessage", {
      channel: "#a",
      text: "hi",
      threadTs: "1.0",
    });
    const b = deriveIdempotencyKey("slack.postMessage", {
      threadTs: "1.0",
      text: "hi",
      channel: "#a",
    });
    expect(a).toBe(b);
  });

  it("differs when toolId differs", () => {
    const params = { channel: "#general", text: "hello" };
    expect(deriveIdempotencyKey("slack.postMessage", params)).not.toBe(
      deriveIdempotencyKey("slack.updateMessage", params),
    );
  });

  it("differs when any param value differs", () => {
    const a = deriveIdempotencyKey("slack.postMessage", {
      channel: "#general",
      text: "hello",
    });
    const b = deriveIdempotencyKey("slack.postMessage", {
      channel: "#general",
      text: "hello!",
    });
    expect(a).not.toBe(b);
  });

  it("canonicalises nested object key order", () => {
    const a = deriveIdempotencyKey("http.request", {
      headers: { Authorization: "Bearer x", "X-Idem": "1" },
      url: "https://api.example.com",
    });
    const b = deriveIdempotencyKey("http.request", {
      url: "https://api.example.com",
      headers: { "X-Idem": "1", Authorization: "Bearer x" },
    });
    expect(a).toBe(b);
  });

  it("preserves array element order (arrays are ordered by definition)", () => {
    const a = deriveIdempotencyKey("github.requestReviewers", {
      pr: 42,
      reviewers: ["alice", "bob"],
    });
    const b = deriveIdempotencyKey("github.requestReviewers", {
      pr: 42,
      reviewers: ["bob", "alice"],
    });
    expect(a).not.toBe(b);
  });

  it("returns 16 hex chars", () => {
    const key = deriveIdempotencyKey("x", {});
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("WriteEffectLedger", () => {
  it("records and retrieves outputs by key", () => {
    const ledger = new WriteEffectLedger();
    expect(ledger.has("k1")).toBe(false);
    ledger.record("k1", "result-1");
    expect(ledger.has("k1")).toBe(true);
    expect(ledger.get("k1")).toBe("result-1");
  });

  it("distinguishes 'not present' from 'cached null' via has()", () => {
    const ledger = new WriteEffectLedger();
    ledger.record("k", null);
    expect(ledger.has("k")).toBe(true);
    expect(ledger.get("k")).toBe(null);
    expect(ledger.has("missing")).toBe(false);
    expect(ledger.get("missing")).toBeUndefined();
  });

  it("tracks size + key set for inspection", () => {
    const ledger = new WriteEffectLedger();
    ledger.record("a", "1");
    ledger.record("b", "2");
    expect(ledger.size()).toBe(2);
    expect(ledger.keys().sort()).toEqual(["a", "b"]);
  });
});

describe("WriteEffectLedger — disk-backed (PR5b)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "effect-ledger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists records to effect_ledger.jsonl scoped by (recipeName, manualRunId)", () => {
    const ledger = new WriteEffectLedger({
      dir,
      scopeKey: "post-notify:mr_abc",
    });
    ledger.record("k1", "ok");
    ledger.record("k2", null);
    const file = path.join(dir, "effect_ledger.jsonl");
    const rows = readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0].scopeKey).toBe("post-notify:mr_abc");
    expect(rows[0].idemKey).toBe("k1");
    expect(rows[0].output).toBe("ok");
    expect(rows[1].output).toBeNull();
  });

  it("rehydrates only entries matching its scopeKey", () => {
    // Pre-populate the ledger with three rows: two for our scope, one
    // for a different attempt. A new ledger must only see its own.
    const file = path.join(dir, "effect_ledger.jsonl");
    const rows = [
      {
        scopeKey: "review:mr_a",
        idemKey: "k1",
        output: "first",
        recordedAt: 1,
      },
      { scopeKey: "review:mr_a", idemKey: "k2", output: null, recordedAt: 2 },
      {
        scopeKey: "other:mr_b",
        idemKey: "k1",
        output: "off-scope",
        recordedAt: 3,
      },
    ];
    writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const ledger = new WriteEffectLedger({ dir, scopeKey: "review:mr_a" });
    expect(ledger.size()).toBe(2);
    expect(ledger.has("k1")).toBe(true);
    expect(ledger.get("k1")).toBe("first");
    expect(ledger.get("k2")).toBeNull();

    const offScope = new WriteEffectLedger({ dir, scopeKey: "review:mr_b" });
    expect(offScope.size()).toBe(0);
  });

  it("retry of the same logical attempt sees prior records (resume semantics)", () => {
    const opts = { dir, scopeKey: "deploy:mr_xyz" };
    const first = new WriteEffectLedger(opts);
    first.record("slack-post-hash", "sent");
    // New process / new ledger constructed with same scope key.
    const second = new WriteEffectLedger(opts);
    expect(second.has("slack-post-hash")).toBe(true);
    expect(second.get("slack-post-hash")).toBe("sent");
  });

  it("skips malformed rows without crashing", () => {
    const file = path.join(dir, "effect_ledger.jsonl");
    writeFileSync(
      file,
      `not-json\n${JSON.stringify({ scopeKey: "s:1", idemKey: "k", output: "v", recordedAt: 1 })}\n{}\n`,
    );
    const ledger = new WriteEffectLedger({ dir, scopeKey: "s:1" });
    expect(ledger.size()).toBe(1);
    expect(ledger.get("k")).toBe("v");
  });

  it("in-memory ledger (no disk option) writes no file", () => {
    const ledger = new WriteEffectLedger();
    ledger.record("k", "v");
    // Nothing was passed for dir, so the temp dir should remain empty.
    expect(() => readFileSync(path.join(dir, "effect_ledger.jsonl"))).toThrow();
    expect(ledger.size()).toBe(1);
  });
});
