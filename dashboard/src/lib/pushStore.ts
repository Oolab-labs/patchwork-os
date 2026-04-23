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
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify([...store.entries()]), "utf8");
  } catch (err) {
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
