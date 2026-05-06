/** @vitest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PushSubscription } from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pushStore.ts captures STORE_PATH at module load via os.homedir() and
// initialises a singleton Map by reading from disk. Tests therefore need
// (a) homedir spied to a temp dir BEFORE import, and (b) a fresh module
// instance per test so state from one test doesn't leak into the next.

let tmpHome: string;
let storePath: string;

function makeSub(endpoint: string): PushSubscription {
  return {
    endpoint,
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
  } as PushSubscription;
}

async function importFresh() {
  vi.resetModules();
  return await import("@/lib/pushStore");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pushstore-test-"));
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
  storePath = path.join(tmpHome, ".claude", "patchwork-push-subscriptions.json");
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("pushStore — startup load", () => {
  it("returns empty list when the store file doesn't exist", async () => {
    const { getSubscriptions } = await importFresh();
    expect(getSubscriptions()).toEqual([]);
  });

  it("loads previously-persisted subscriptions on startup", async () => {
    const a = makeSub("https://push.example/a");
    const b = makeSub("https://push.example/b");
    fs.writeFileSync(
      storePath,
      JSON.stringify([[a.endpoint, a], [b.endpoint, b]]),
    );
    const { getSubscriptions } = await importFresh();
    expect(getSubscriptions()).toHaveLength(2);
    expect(getSubscriptions().map((s) => s.endpoint).sort()).toEqual([
      a.endpoint,
      b.endpoint,
    ]);
  });

  it("treats malformed JSON as an empty store rather than throwing", async () => {
    fs.writeFileSync(storePath, "{not json");
    const { getSubscriptions } = await importFresh();
    expect(getSubscriptions()).toEqual([]);
  });
});

describe("pushStore — add/remove/get", () => {
  it("add persists to disk and shows up in getSubscriptions()", async () => {
    const { addSubscription, getSubscriptions } = await importFresh();
    const sub = makeSub("https://push.example/x");
    addSubscription(sub);

    expect(getSubscriptions()).toEqual([sub]);
    expect(fs.existsSync(storePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8")) as [
      string,
      PushSubscription,
    ][];
    expect(onDisk).toEqual([[sub.endpoint, sub]]);
  });

  it("add is idempotent on repeated endpoint (replaces, no duplicate)", async () => {
    const { addSubscription, getSubscriptions } = await importFresh();
    const v1 = makeSub("https://push.example/dup");
    const v2 = {
      ...makeSub("https://push.example/dup"),
      keys: { p256dh: "new", auth: "new" },
    } as PushSubscription;

    addSubscription(v1);
    addSubscription(v2);

    const subs = getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual(v2);
  });

  it("remove drops the matching endpoint and rewrites disk", async () => {
    const { addSubscription, removeSubscription, getSubscriptions } =
      await importFresh();
    const a = makeSub("https://push.example/a");
    const b = makeSub("https://push.example/b");
    addSubscription(a);
    addSubscription(b);

    removeSubscription(a.endpoint);

    expect(getSubscriptions()).toEqual([b]);
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8")) as [
      string,
      PushSubscription,
    ][];
    expect(onDisk).toEqual([[b.endpoint, b]]);
  });

  it("remove on an unknown endpoint is a no-op", async () => {
    const { addSubscription, removeSubscription, getSubscriptions } =
      await importFresh();
    const a = makeSub("https://push.example/a");
    addSubscription(a);

    removeSubscription("https://push.example/never-added");

    expect(getSubscriptions()).toEqual([a]);
  });

  it("getSubscriptions returns a fresh array each call (not the live Map view)", async () => {
    const { addSubscription, getSubscriptions } = await importFresh();
    addSubscription(makeSub("https://push.example/a"));

    const first = getSubscriptions();
    addSubscription(makeSub("https://push.example/b"));
    // first should not have been mutated by the second add — it's a snapshot.
    expect(first).toHaveLength(1);
    expect(getSubscriptions()).toHaveLength(2);
  });

  it("write failure is swallowed (warn-and-continue, in-memory state stands)", async () => {
    const { addSubscription, getSubscriptions } = await importFresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sub = makeSub("https://push.example/err");
    // Make persist throw by removing the parent dir between init and add.
    fs.rmSync(path.dirname(storePath), { recursive: true });

    expect(() => addSubscription(sub)).not.toThrow();
    expect(getSubscriptions()).toEqual([sub]);
    expect(warn).toHaveBeenCalled();
  });
});
