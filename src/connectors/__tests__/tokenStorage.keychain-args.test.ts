/**
 * Audit 2026-06-03 HIGH #3 — macOS keychain write must not expose the
 * credential in the `security` process argument list.
 *
 * Bug: setMacOSKeychainItemSync called
 *   spawnSync("security", [..., "-w", value, "-U"])
 * The value (full credential JSON) appears in `ps aux` for any local process
 * to read while the command runs.
 *
 * Fix: credential is passed via environment variable (PATCHWORK_KCV) to a
 * /bin/sh wrapper; the `security` binary is invoked as `$PATCHWORK_KCV`
 * expansion inside the shell — the bridge process and the shell subprocess
 * never have the credential in their args arrays.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must precede all imports that transitively use node:child_process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
    })),
  };
});

import { spawnSync } from "node:child_process";
import { __setKeychainOpsForTest, storeTokens } from "../tokenStorage.js";

describe("macOS keychain write: credential not in process args (audit 2026-06-03 HIGH #3)", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-test-tokens-high3-${Date.now()}`);

  beforeEach(() => {
    process.env.PATCHWORK_HOME = tmpDir;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "auto";
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    // No keychain override — exercise the real platform-specific path.
    __setKeychainOpsForTest(null);
    vi.mocked(spawnSync).mockClear();
  });

  afterEach(() => {
    __setKeychainOpsForTest(null);
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it.skipIf(process.platform !== "darwin")(
    "credential does not appear in spawnSync args",
    async () => {
      const secret = "SUPER_SECRET_CRED_VALUE_HIGH3";

      await storeTokens("darwin-high3-provider", { accessToken: secret });

      // At least one spawnSync call must have been made for the keychain path.
      expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThan(0);

      // The secret must NOT appear in ANY argument of ANY spawnSync call.
      for (const call of vi.mocked(spawnSync).mock.calls) {
        const args = (call[1] ?? []) as string[];
        const joined = args.join("\x00");
        expect(
          joined,
          `credential appeared in spawnSync args: ${JSON.stringify(args)}`,
        ).not.toContain(secret);
      }

      // The credential MUST appear in the env object of at least one call.
      const envValues = vi
        .mocked(spawnSync)
        .mock.calls.flatMap((call) =>
          Object.values(
            (call[2] as { env?: Record<string, string> } | undefined)?.env ??
              {},
          ),
        );
      expect(
        envValues.some((v) => typeof v === "string" && v.includes(secret)),
        "credential must be passed via an env var to the subprocess",
      ).toBe(true);
    },
  );
});
