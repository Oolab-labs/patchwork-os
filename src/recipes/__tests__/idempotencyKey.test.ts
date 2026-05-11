import { describe, expect, it } from "vitest";
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
