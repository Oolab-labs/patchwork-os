import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PushSubscription } from "web-push";

const STORE_PATH = path.join(os.homedir(), ".claude", "patchwork-push-subscriptions.json");

function load(): Map<string, PushSubscription> {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const entries = JSON.parse(raw) as [string, PushSubscription][];
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function persist(store: Map<string, PushSubscription>): void {
  // Atomic write — temp + rename — so a crash mid-write can't truncate
  // the subscription store (which would silently wipe every push
  // subscription on next boot; load() catches parse errors and resets
  // to an empty Map). Audit 2026-05-17.
  const tmp = `${STORE_PATH}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify([...store.entries()]), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone or never created */
    }
    console.warn("[pushStore] Failed to persist subscriptions:", err);
  }
}

const store = load();

export function addSubscription(sub: PushSubscription): void {
  store.set(sub.endpoint, sub);
  persist(store);
}

export function removeSubscription(endpoint: string): void {
  store.delete(endpoint);
  persist(store);
}

export function getSubscriptions(): PushSubscription[] {
  return [...store.values()];
}
