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
  // to an empty Map).
  //
  // #605: explicit fsync of the temp file before rename. Without it,
  // ext4 (`data=writeback`) and APFS edge cases let the rename
  // complete while the temp file's data is still in the page cache —
  // a crash between rename and flush can leave the destination with
  // zero bytes despite the atomic-rename promise. Pattern matches the
  // bridge's `writeFileAtomicSync` (src/writeFileAtomic.ts).
  const tmp = `${STORE_PATH}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  let fd: number | null = null;
  try {
    const body = JSON.stringify([...store.entries()]);
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
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
