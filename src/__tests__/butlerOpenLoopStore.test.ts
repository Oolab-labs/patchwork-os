import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ButlerOpenLoopStore } from "../butler/openLoopStore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-open-loops-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ButlerOpenLoopStore", () => {
  it("persists open loops across store instances and keeps facts separate", () => {
    const a = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
    const created = a.create({
      kind: "promise",
      text: "I promised David I'd bring his book",
      source: "shortcut",
    });

    const b = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
    expect(b.list()).toEqual([created]);
    expect(readFileSync(path.join(dir, "open_loops.jsonl"), "utf8")).toContain(
      "I promised David",
    );
    expect(() => readFileSync(path.join(dir, "facts.jsonl"), "utf8")).toThrow();
  });

  it("completion appends history; reopen returns the loop to the open set", () => {
    let now = 100;
    const store = new ButlerOpenLoopStore({
      dir,
      now: () => ++now,
      logger: { warn: () => {} },
    });
    const created = store.create({ kind: "remember", text: "Buy batteries" });

    const before = readFileSync(path.join(dir, "open_loops.jsonl"), "utf8");
    const done = store.complete(created.id);
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeTypeOf("number");
    expect(store.list({ status: "open" })).toHaveLength(0);

    const afterComplete = readFileSync(
      path.join(dir, "open_loops.jsonl"),
      "utf8",
    );
    expect(afterComplete.startsWith(before)).toBe(true);
    expect(afterComplete).toContain('"event":"completed"');

    const reopened = store.reopen(created.id);
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeUndefined();
    expect(store.list({ status: "open" })).toHaveLength(1);
  });

  it("erasure destroys the personal text and leaves only a content-free marker", () => {
    const store = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
    const keep = store.create({ kind: "remember", text: "Buy milk" });
    const erase = store.create({
      kind: "waiting",
      text: "Waiting for private refund details",
    });

    store.erase(erase.id);

    const raw = readFileSync(path.join(dir, "open_loops.jsonl"), "utf8");
    expect(raw).not.toContain("private refund details");
    expect(raw).toContain("Buy milk");
    expect(raw).toContain('"event":"erased"');
    expect(store.get(erase.id)).toBeUndefined();
    expect(store.get(keep.id)?.text).toBe("Buy milk");
  });

  it("ignores a malformed row without losing readable neighbours", () => {
    const warnings: string[] = [];
    const store = new ButlerOpenLoopStore({
      dir,
      logger: { warn: (message) => warnings.push(message) },
    });
    const first = store.create({ kind: "remember", text: "First" });

    const file = path.join(dir, "open_loops.jsonl");
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(file, "{not json}\n");

    const second = store.create({ kind: "waiting", text: "Second" });
    const ids = store.list().map((loop) => loop.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("uses UUID ids so separate store instances do not share a counter", () => {
    const a = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
    const b = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
    const one = a.create({ kind: "remember", text: "One" });
    const two = b.create({ kind: "remember", text: "Two" });
    expect(one.id).not.toBe(two.id);
  });

  it("brief is deterministic and oldest-open-first", () => {
    let now = 1000;
    const ids = ["loop-a", "evt-a", "loop-b", "evt-b", "loop-c", "evt-c"];
    const store = new ButlerOpenLoopStore({
      dir,
      now: () => ++now,
      uuid: () => ids.shift() ?? "extra",
      logger: { warn: () => {} },
    });
    store.create({ kind: "remember", text: "A" });
    store.create({ kind: "promise", text: "B" });
    store.create({ kind: "waiting", text: "C" });

    const brief = store.brief(2);
    expect(brief.openCount).toBe(3);
    expect(brief.items.map((item) => item.text)).toEqual(["A", "B"]);
    expect(brief.items.every((item) => item.reason === "Still open")).toBe(true);
  });

  it("rejects empty, oversized, and NUL-containing text", () => {
    const store = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
    expect(() => store.create({ kind: "remember", text: "  " })).toThrow(
      /text is required/,
    );
    expect(() =>
      store.create({ kind: "remember", text: "x".repeat(1025) }),
    ).toThrow(/exceeds 1024/);
    expect(() =>
      store.create({ kind: "remember", text: "bad\0text" }),
    ).toThrow(/null bytes/);
  });
});
