/** @vitest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findBridge, resolveBridgeUrl } from "@/lib/bridge";

// findBridge() reads process.env and ~/.claude/ide synchronously, so we
// build a real temp dir and point os.homedir() at it. This avoids fs
// mocking (which is brittle around node: prefixes) and keeps the test
// behavior identical to production code paths.

const ENV_KEYS = [
  "PATCHWORK_BRIDGE_URL",
  "PATCHWORK_BRIDGE_TOKEN",
  "PATCHWORK_BRIDGE_PORT",
] as const;

function clearBridgeEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

let tmpHome: string;
let ideDir: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  ideDir = path.join(tmpHome, ".claude", "ide");
  fs.mkdirSync(ideDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  clearBridgeEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearBridgeEnv();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeLock(port: number, body: Record<string, unknown>) {
  fs.writeFileSync(path.join(ideDir, `${port}.lock`), JSON.stringify(body));
}

describe("resolveBridgeUrl", () => {
  it("uses 127.0.0.1 with the lock's port for local locks", () => {
    expect(resolveBridgeUrl({ port: 1234 }, "/api/x")).toBe(
      "http://127.0.0.1:1234/api/x",
    );
  });

  it("uses PATCHWORK_BRIDGE_URL when port=0 sentinel is set", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com";
    expect(resolveBridgeUrl({ port: 0 }, "/api/x")).toBe(
      "https://bridge.example.com/api/x",
    );
  });

  it("strips a trailing slash from PATCHWORK_BRIDGE_URL", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com/";
    expect(resolveBridgeUrl({ port: 0 }, "/api/x")).toBe(
      "https://bridge.example.com/api/x",
    );
  });

  it("falls back to localhost when port=0 but no remote URL is set", () => {
    expect(resolveBridgeUrl({ port: 0 }, "/api/x")).toBe(
      "http://127.0.0.1:0/api/x",
    );
  });

  it("ignores PATCHWORK_BRIDGE_URL for non-zero ports", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com";
    expect(resolveBridgeUrl({ port: 4242 }, "/x")).toBe(
      "http://127.0.0.1:4242/x",
    );
  });
});

describe("findBridge — remote shortcut", () => {
  it("returns a synthetic remote lock when both URL and TOKEN are set", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com";
    process.env.PATCHWORK_BRIDGE_TOKEN = "remote-token";
    expect(findBridge()).toEqual({
      pid: 0,
      port: 0,
      workspace: "",
      authToken: "remote-token",
      isBridge: true,
    });
  });

  it("does not take the remote shortcut if only URL is set", () => {
    process.env.PATCHWORK_BRIDGE_URL = "https://bridge.example.com";
    expect(findBridge()).toBeNull();
  });

  it("does not take the remote shortcut if only TOKEN is set", () => {
    process.env.PATCHWORK_BRIDGE_TOKEN = "x";
    expect(findBridge()).toBeNull();
  });
});

describe("findBridge — lock-file scan", () => {
  it("returns null when ~/.claude/ide doesn't exist", () => {
    fs.rmSync(ideDir, { recursive: true });
    expect(findBridge()).toBeNull();
  });

  it("returns null when no .lock files are present", () => {
    expect(findBridge()).toBeNull();
  });

  it("picks up a valid bridge lock with a live PID", () => {
    writeLock(8080, {
      pid: process.pid, // own PID is always alive
      workspace: "/some/where",
      authToken: "abc",
      isBridge: true,
    });
    expect(findBridge()).toEqual({
      pid: process.pid,
      port: 8080,
      workspace: "/some/where",
      authToken: "abc",
      isBridge: true,
    });
  });

  it("skips locks where isBridge is missing/false (IDE locks, not bridge)", () => {
    writeLock(7000, { pid: process.pid, authToken: "x" });
    writeLock(7001, { pid: process.pid, authToken: "x", isBridge: false });
    expect(findBridge()).toBeNull();
  });

  it("skips locks whose PID is not alive", () => {
    // PID 1 is init (alive on every unix), but we want a definitely-dead
    // PID. Spawn-and-wait would be flaky; instead spy on process.kill.
    const dead = 999_999_999;
    writeLock(9001, { pid: dead, authToken: "x", isBridge: true });
    expect(findBridge()).toBeNull();
  });

  it("skips malformed JSON without throwing", () => {
    fs.writeFileSync(path.join(ideDir, "5555.lock"), "{not json");
    writeLock(6666, {
      pid: process.pid,
      authToken: "good",
      isBridge: true,
    });
    expect(findBridge()?.port).toBe(6666);
  });

  it("ignores non-port lock filenames (e.g. left-over .lock without digits)", () => {
    fs.writeFileSync(path.join(ideDir, "stale.lock"), "{}");
    expect(findBridge()).toBeNull();
  });

  it("prefers the most-recently-modified valid lock when several exist", () => {
    writeLock(3001, {
      pid: process.pid,
      authToken: "old",
      isBridge: true,
    });
    // Bump mtime backward on the older file so 3002 wins.
    const past = Date.now() / 1000 - 60;
    fs.utimesSync(path.join(ideDir, "3001.lock"), past, past);
    writeLock(3002, {
      pid: process.pid,
      authToken: "new",
      isBridge: true,
    });
    expect(findBridge()?.authToken).toBe("new");
  });

  it("honours PATCHWORK_BRIDGE_PORT to pin a specific lock", () => {
    writeLock(5001, {
      pid: process.pid,
      authToken: "no",
      isBridge: true,
    });
    writeLock(5002, {
      pid: process.pid,
      authToken: "yes",
      isBridge: true,
    });
    process.env.PATCHWORK_BRIDGE_PORT = "5002";
    expect(findBridge()?.authToken).toBe("yes");
  });

  it("returns null if PATCHWORK_BRIDGE_PORT pins a non-existent lock", () => {
    writeLock(5001, {
      pid: process.pid,
      authToken: "x",
      isBridge: true,
    });
    process.env.PATCHWORK_BRIDGE_PORT = "9999";
    expect(findBridge()).toBeNull();
  });

  it("treats missing optional fields as empty strings rather than crashing", () => {
    writeLock(4242, { pid: process.pid, isBridge: true });
    const got = findBridge();
    expect(got).not.toBeNull();
    expect(got!.workspace).toBe("");
    expect(got!.authToken).toBe("");
  });
});
