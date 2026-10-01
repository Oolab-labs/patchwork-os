/** @vitest-environment node */
/**
 * The push subscription store had no cap: an authenticated user could grow
 * `patchwork-push-subscriptions.json` without limit, and every relay fan-out
 * is O(N) outbound HTTPS requests over it. Security sweep 2026-10-01, L2.
 *
 * Same harness as pushStore.test.ts: homedir spied to a temp dir before a
 * fresh import, so the singleton Map starts empty per test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscription } from "web-push";

let tmpHome: string;

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pushstore-cap-"));
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("pushStore — subscription cap", () => {
  it("exports a finite cap", async () => {
    const { MAX_SUBSCRIPTIONS } = await importFresh();
    expect(Number.isInteger(MAX_SUBSCRIPTIONS)).toBe(true);
    expect(MAX_SUBSCRIPTIONS).toBeGreaterThan(0);
  });

  it("refuses a NEW endpoint once the cap is reached, and says so", async () => {
    const { addSubscription, getSubscriptions, MAX_SUBSCRIPTIONS } =
      await importFresh();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      expect(addSubscription(makeSub(`https://push.example.test/s/${i}`))).toBe(
        true,
      );
    }
    expect(getSubscriptions()).toHaveLength(MAX_SUBSCRIPTIONS);
    expect(addSubscription(makeSub("https://push.example.test/s/overflow"))).toBe(
      false,
    );
    expect(getSubscriptions()).toHaveLength(MAX_SUBSCRIPTIONS);
  });

  it("still accepts a re-subscribe of an EXISTING endpoint at the cap (pushsubscriptionchange)", async () => {
    const { addSubscription, getSubscriptions, MAX_SUBSCRIPTIONS } =
      await importFresh();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      addSubscription(makeSub(`https://push.example.test/s/${i}`));
    }
    expect(addSubscription(makeSub("https://push.example.test/s/0"))).toBe(true);
    expect(getSubscriptions()).toHaveLength(MAX_SUBSCRIPTIONS);
  });

  it("a removal frees a slot", async () => {
    const { addSubscription, removeSubscription, MAX_SUBSCRIPTIONS } =
      await importFresh();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      addSubscription(makeSub(`https://push.example.test/s/${i}`));
    }
    removeSubscription("https://push.example.test/s/0");
    expect(addSubscription(makeSub("https://push.example.test/s/new"))).toBe(
      true,
    );
  });
});
