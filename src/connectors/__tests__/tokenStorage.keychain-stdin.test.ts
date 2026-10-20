/**
 * macOS keychain write keeps the secret out of EVERY process's argv
 * (Private/52 LOW, follow-up to audit 2026-06-03 HIGH #3).
 *
 * The HIGH #3 fix moved the secret from the bridge's own `spawnSync` args into
 * an environment variable read by a `/bin/sh -c` wrapper — and the wrapper
 * then expanded it into `security ... -w "$PATCHWORK_KCV"`. So the `security`
 * child carried the secret in its argv anyway, readable in `ps` for the life
 * of the call. The earlier test asserted only the bridge's own args, which is
 * why it passed: the exposure had moved one process down.
 *
 * `security` reads a password from argv or from a prompt. The prompt is
 * capped at 128 characters (measured: a 5,000-character value stored as 128,
 * exit 0), so it cannot carry a token. `security -i` reads whole commands
 * from STDIN; with `-X <hex>` the value needs no quoting. Its line is capped
 * too (measured: ~4 KB, stored TRUNCATED), so the write is read back and
 * refused on any mismatch rather than leaving a corrupted credential.
 *
 * `process.platform` is stubbed so this runs on every CI cell.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = new Map<string, string>();
let truncateTo: number | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import {
  __setKeychainOpsForTest,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "../tokenStorage.js";

function ok(stdout = "") {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  };
}

/** A fake `security` that behaves like the measured binary. */
function fakeSecurity(cmd: string, args: string[], opts?: { input?: string }) {
  const argv = [cmd, ...args];
  if (args[0] === "-i") {
    const line = opts?.input ?? "";
    const m = line.match(/-s "([^"]+)" -a "([^"]+)" -U -X ([0-9a-f]+)/);
    if (m) {
      let value = Buffer.from(m[3] as string, "hex").toString("utf8");
      if (truncateTo !== undefined) value = value.slice(0, truncateTo);
      keychain.set(m[1] as string, value);
    }
    return ok();
  }
  if (args.includes("find-generic-password")) {
    const v = keychain.get(args[args.indexOf("-s") + 1] as string);
    return v === undefined ? { ...ok(), status: 44 } : ok(`${v}\n`);
  }
  if (args.includes("delete-generic-password")) {
    keychain.delete(args[args.indexOf("-s") + 1] as string);
    return ok();
  }
  void argv;
  return ok();
}

const tmpDir = join(os.tmpdir(), `patchwork-kc-stdin-${process.pid}`);
const realPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.stubEnv("PATCHWORK_HOME", tmpDir);
  vi.stubEnv("PATCHWORK_TOKEN_STORAGE_BACKEND", "auto");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  __setKeychainOpsForTest(null);
  keychain.clear();
  truncateTo = undefined;
  vi.mocked(spawnSync).mockReset();
  vi.mocked(spawnSync).mockImplementation(
    fakeSecurity as unknown as typeof spawnSync,
  );
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

const SECRET = "SUPER_SECRET_CRED_VALUE_LOW_KC";

describe("macOS keychain write: secret in no argv and no env", () => {
  it("never passes the secret (or its hex) as an argument or env var", () => {
    storeSecretJsonSync("kc-provider", { accessToken: SECRET });
    const hex = Buffer.from(SECRET, "utf8").toString("hex");
    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const argv = [String(call[0]), ...((call[1] ?? []) as string[])].join(
        "\0",
      );
      expect(argv).not.toContain(SECRET);
      expect(argv).not.toContain(hex);
      const env = (call[2] as { env?: Record<string, string> } | undefined)
        ?.env;
      for (const v of Object.values(env ?? {})) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  it("round-trips through the keychain", () => {
    storeSecretJsonSync("kc-provider", { accessToken: SECRET });
    expect(keychain.size).toBe(1);
    expect(
      getSecretJsonSync<{ accessToken: string }>("kc-provider")?.accessToken,
    ).toBe(SECRET);
  });

  it("a truncated write is refused: no corrupted keychain item, encrypted file used instead", () => {
    truncateTo = 10;
    storeSecretJsonSync("kc-provider", { accessToken: SECRET });
    // The truncated item is not left behind…
    expect(keychain.size).toBe(0);
    // …and auto mode falls back to the encrypted file, so the value survives.
    expect(
      getSecretJsonSync<{ accessToken: string }>("kc-provider")?.accessToken,
    ).toBe(SECRET);
  });
});
