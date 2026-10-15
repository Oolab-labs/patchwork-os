/**
 * On a Linux host without `secret-tool` installed (common in minimal container
 * images), every keychain read used to fork the whole Node process just to
 * fail with ENOENT before falling back to the encrypted file. GET /connections
 * performs dozens of such reads synchronously, so the forks blocked the event
 * loop for seconds.
 *
 * A missing binary cannot appear mid-process in any way we need to honour, so
 * ENOENT is memoised: the first spawn proves the helper is absent and later
 * calls return the unavailable result without spawning. Every OTHER failure
 * (timeout, non-zero exit, locked keyring) is transient or per-key and must
 * keep spawning exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import {
  __resetLinuxSecretToolProbeForTest,
  deleteLinuxSecretSync,
  getLinuxSecretSync,
  setLinuxSecretSync,
} from "../tokenStorage.js";

const KEY = "patchwork-os.github";

type SpawnResult = ReturnType<typeof spawnSync>;
const asResult = (r: object) => r as unknown as SpawnResult;

function enoent() {
  const error = Object.assign(new Error("spawnSync secret-tool ENOENT"), {
    code: "ENOENT",
    errno: -2,
    syscall: "spawnSync secret-tool",
    path: "secret-tool",
  });
  return {
    pid: 0,
    output: [null, null, null],
    stdout: null,
    stderr: null,
    status: null,
    signal: null,
    error,
  };
}

function exitWith(status: number) {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status,
    signal: null,
  };
}

function timedOut() {
  const error = Object.assign(new Error("spawnSync secret-tool ETIMEDOUT"), {
    code: "ETIMEDOUT",
  });
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGTERM",
    error,
  };
}

const spawn = () => vi.mocked(spawnSync);

beforeEach(() => {
  __resetLinuxSecretToolProbeForTest();
  spawn().mockReset();
});

afterEach(() => {
  __resetLinuxSecretToolProbeForTest();
  spawn().mockReset();
});

describe("Linux secret-tool absent (ENOENT) is memoised", () => {
  it("N reads spawn secret-tool once, all returning null", () => {
    spawn().mockImplementation(() => asResult(enoent()));
    for (let i = 0; i < 20; i++) {
      expect(getLinuxSecretSync(KEY)).toBeNull();
    }
    expect(spawn()).toHaveBeenCalledTimes(1);
  });

  it("set and delete also stop spawning once absence is known", () => {
    spawn().mockImplementation(() => asResult(enoent()));
    expect(setLinuxSecretSync(KEY, "v")).toBe(false);
    expect(setLinuxSecretSync(KEY, "v")).toBe(false);
    expect(getLinuxSecretSync(KEY)).toBeNull();
    expect(deleteLinuxSecretSync(KEY)).toBe(false);
    expect(spawn()).toHaveBeenCalledTimes(1);
  });

  it("the reset hook makes the next call probe again", () => {
    spawn().mockImplementation(() => asResult(enoent()));
    getLinuxSecretSync(KEY);
    getLinuxSecretSync(KEY);
    expect(spawn()).toHaveBeenCalledTimes(1);
    __resetLinuxSecretToolProbeForTest();
    getLinuxSecretSync(KEY);
    expect(spawn()).toHaveBeenCalledTimes(2);
  });
});

describe("other secret-tool failures are NOT memoised", () => {
  it("a non-zero exit (item missing / keyring locked) keeps spawning", () => {
    spawn().mockImplementation(() => asResult(exitWith(1)));
    for (let i = 0; i < 5; i++) {
      expect(getLinuxSecretSync(KEY)).toBeNull();
    }
    expect(spawn()).toHaveBeenCalledTimes(5);
  });

  it("a timeout keeps spawning", () => {
    spawn().mockImplementation(() => asResult(timedOut()));
    for (let i = 0; i < 5; i++) {
      expect(getLinuxSecretSync(KEY)).toBeNull();
    }
    expect(spawn()).toHaveBeenCalledTimes(5);
  });

  it("a successful lookup still returns the stored value every time", () => {
    spawn().mockImplementation(() =>
      asResult({ ...exitWith(0), stdout: "secret\n" }),
    );
    expect(getLinuxSecretSync(KEY)).toBe("secret");
    expect(getLinuxSecretSync(KEY)).toBe("secret");
    expect(spawn()).toHaveBeenCalledTimes(2);
  });
});
