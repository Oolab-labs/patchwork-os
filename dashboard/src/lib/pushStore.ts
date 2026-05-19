import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PushSubscription } from "web-push";

const STORE_PATH = path.join(os.homedir(), ".claude", "patchwork-push-subscriptions.json");

/**
 * Per-subscription preferences. Both default `true` so existing
 * subscriptions keep firing every event class until the user opts out
 * (e.g. via a future Settings toggle). Adding new event classes here
 * needs the same default to preserve back-compat.
 */
export interface PushPrefs {
  approvals: boolean;
  halts: boolean;
}

const DEFAULT_PREFS: PushPrefs = { approvals: true, halts: true };

export interface PushEntry {
  sub: PushSubscription;
  prefs: PushPrefs;
}

/**
 * Backwards-compatible loader. The on-disk format is one of two shapes
 * depending on what wrote it:
 *
 *   - legacy: `[endpoint, PushSubscription][]`
 *   - v2:     `[endpoint, { sub, prefs }][]`
 *
 * Detect per-entry (not file-level) so a partial in-place migration on
 * a tab that came back online doesn't blank the rest of the store.
 */
function load(): Map<string, PushEntry> {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const entries = JSON.parse(raw) as [string, unknown][];
    const out = new Map<string, PushEntry>();
    for (const [endpoint, value] of entries) {
      if (
        value &&
        typeof value === "object" &&
        "sub" in (value as object) &&
        "prefs" in (value as object)
      ) {
        const v = value as { sub: PushSubscription; prefs: Partial<PushPrefs> };
        out.set(endpoint, {
          sub: v.sub,
          prefs: { ...DEFAULT_PREFS, ...v.prefs },
        });
      } else {
        // legacy shape: the raw subscription
        out.set(endpoint, {
          sub: value as PushSubscription,
          prefs: { ...DEFAULT_PREFS },
        });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function persist(store: Map<string, PushEntry>): void {
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
  const existing = store.get(sub.endpoint);
  store.set(sub.endpoint, {
    sub,
    // Preserve prefs on resubscribe (pushsubscriptionchange path) so a
    // user who opted out of halts stays opted out across browser
    // restarts. New endpoints inherit DEFAULT_PREFS.
    prefs: existing?.prefs ?? { ...DEFAULT_PREFS },
  });
  persist(store);
}

export function removeSubscription(endpoint: string): void {
  store.delete(endpoint);
  persist(store);
}

/** All subscriptions, regardless of preference. Callers filter. */
export function getSubscriptions(): PushSubscription[] {
  return [...store.values()].map((e) => e.sub);
}

/**
 * Subscriptions opted in to a specific event class. Use this from the
 * relay routes so a user who toggled off halt notifications doesn't
 * keep getting them.
 */
export function getSubscriptionsFor(kind: keyof PushPrefs): PushSubscription[] {
  return [...store.values()].filter((e) => e.prefs[kind]).map((e) => e.sub);
}

/** Read a subscription's prefs (defaults if unknown). */
export function getPrefs(endpoint: string): PushPrefs {
  return store.get(endpoint)?.prefs ?? { ...DEFAULT_PREFS };
}

/** Update prefs for an existing subscription. No-op for unknown endpoints. */
export function setPrefs(endpoint: string, prefs: Partial<PushPrefs>): boolean {
  const entry = store.get(endpoint);
  if (!entry) return false;
  store.set(endpoint, { sub: entry.sub, prefs: { ...entry.prefs, ...prefs } });
  persist(store);
  return true;
}
